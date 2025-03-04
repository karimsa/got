import net = require('net');
import {ClientRequest, IncomingMessage} from 'http';
import {Delays} from './types';
import unhandler from './unhandle';

const reentry = Symbol('reentry');
const noop = (): void => {};
const isTestEnv = process.env.NODE_ENV === 'test';

interface TimedOutOptions {
	host?: string;
	hostname?: string;
	protocol?: string;
}

export class TimeoutError extends Error {
	code: string;

	constructor(threshold: number, public event: string) {
		super(`Timeout awaiting '${event}' for ${threshold}ms`);

		this.name = 'TimeoutError';
		this.code = 'ETIMEDOUT';
	}
}

export const kTimers = Symbol('timers');

export default (request: ClientRequest, delays: Delays, options: TimedOutOptions) => {
	if (Reflect.has(request, reentry)) {
		return noop;
	}

	request[reentry] = true;
	const cancelers: Array<typeof noop> = [];
	const {once, unhandleAll} = unhandler();
	const timers: typeof global =
		isTestEnv ?
		// @ts-ignore
			request[kTimers] || global :
			global;

	const addTimeout = (delay: number, callback: (...args: unknown[]) => void, ...args: unknown[]): (typeof noop) => {
		// Event loop order is timers, poll, immediates.
		// The timed event may emit during the current tick poll phase, so
		// defer calling the handler until the poll phase completes.
		let immediate: NodeJS.Immediate;
		const timeout: NodeJS.Timeout = timers.setTimeout(() => {
			immediate = timers.setImmediate(callback, delay, ...args);
			/* istanbul ignore next: added in node v9.7.0 */
			if (immediate.unref) {
				immediate.unref();
			}
		}, delay);

		/* istanbul ignore next: in order to support electron renderer */
		if (timeout.unref) {
			timeout.unref();
		}

		const cancel = (): void => {
			timers.clearTimeout(timeout);
			timers.clearImmediate(immediate);
		};

		cancelers.push(cancel);

		return cancel;
	};

	const {host, hostname} = options;

	const timeoutHandler = (delay: number, event: string): void => {
		request.emit('error', new TimeoutError(delay, event));
		request.abort();
	};

	const cancelTimeouts = (): void => {
		for (const cancel of cancelers) {
			cancel();
		}

		unhandleAll();
	};

	request.on('error', error => {
		if (error.message !== 'socket hang up') {
			cancelTimeouts();
		}
	});

	once(request, 'response', (response: IncomingMessage): void => {
		once(response, 'end', cancelTimeouts);
	});

	if (typeof delays.request !== 'undefined') {
		addTimeout(delays.request, timeoutHandler, 'request');
	}

	if (typeof delays.socket !== 'undefined') {
		const socketTimeoutHandler = (): void => {
			timeoutHandler(delays.socket, 'socket');
		};

		request.setTimeout(delays.socket, socketTimeoutHandler);

		// `request.setTimeout(0)` causes a memory leak.
		// We can just remove the listener and forget about the timer - it's unreffed.
		// See https://github.com/sindresorhus/got/issues/690
		cancelers.push(() => {
			request.removeListener('timeout', socketTimeoutHandler);
		});
	}

	once(request, 'socket', (socket: net.Socket): void => {
		// TODO: There seems to not be a 'socketPath' on the request, but there IS a socket.remoteAddress
		const {socketPath} = request as any;

		/* istanbul ignore next: hard to test */
		if (socket.connecting) {
			if (typeof delays.lookup !== 'undefined' && !socketPath && !net.isIP(hostname || host) && typeof (socket.address() as net.AddressInfo).address === 'undefined') {
				const cancelTimeout = addTimeout(delays.lookup, timeoutHandler, 'lookup');
				once(socket, 'lookup', cancelTimeout);
			}

			if (typeof delays.connect !== 'undefined') {
				const timeConnect = (): (() => void) => addTimeout(delays.connect, timeoutHandler, 'connect');

				if (socketPath || net.isIP(hostname || host)) {
					once(socket, 'connect', timeConnect());
				} else {
					once(socket, 'lookup', (error: Error): void => {
						if (error === null) {
							once(socket, 'connect', timeConnect());
						}
					});
				}
			}

			if (typeof delays.secureConnect !== 'undefined' && options.protocol === 'https:') {
				once(socket, 'connect', (): void => {
					const cancelTimeout = addTimeout(delays.secureConnect, timeoutHandler, 'secureConnect');
					once(socket, 'secureConnect', cancelTimeout);
				});
			}
		}

		if (typeof delays.send !== 'undefined') {
			const timeRequest = (): (() => void) => addTimeout(delays.send, timeoutHandler, 'send');
			/* istanbul ignore next: hard to test */
			if (socket.connecting) {
				once(socket, 'connect', (): void => {
					once(request, 'upload-complete', timeRequest());
				});
			} else {
				once(request, 'upload-complete', timeRequest());
			}
		}
	});

	if (typeof delays.response !== 'undefined') {
		once(request, 'upload-complete', (): void => {
			const cancelTimeout = addTimeout(delays.response!, timeoutHandler, 'response');
			once(request, 'response', cancelTimeout);
		});
	}

	return cancelTimeouts;
};

declare module 'http' {
	interface ClientRequest {
		[reentry]: boolean;
	}
}
