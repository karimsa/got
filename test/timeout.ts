import EventEmitter = require('events');
import http = require('http');
import net = require('net');
import getStream = require('get-stream');
import {PassThrough} from 'stream';
import test from 'ava';
import pEvent = require('p-event');
import got from '../source';
import timedOut from '../source/utils/timed-out';
import withServer from './helpers/with-server';
import slowDataStream from './helpers/slow-data-stream';

const requestDelay = 800;

const errorMatcher = {
	instanceOf: got.TimeoutError,
	code: 'ETIMEDOUT'
};

const keepAliveAgent = new http.Agent({
	keepAlive: true
});

const defaultHandler = got => {
	return (request, response) => {
		request.resume();
		request.on('end', async () => {
			try {
				got.tickTimers(requestDelay + 1);
				setTimeout(() => response.end('OK'), 2);
			} catch (error) {
				console.error(error.stack || error);
				response.statusCode = 500;
				response.end();
			}
		});
	};
};

const downloadHandler = got => (_request, response) => {
	response.writeHead(200, {
		'transfer-encoding': 'chunked'
	});
	response.flushHeaders();
	slowDataStream(got).pipe(response);
};

test('timeout option', withServer, async (t, server, got) => {
	server.get('/', defaultHandler(got));

	await t.throwsAsync(
		got({
			timeout: 1,
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'request\' for 1ms'
		}
	);
});

test('timeout option as object', withServer, async (t, server, got) => {
	server.get('/', defaultHandler(got));

	await t.throwsAsync(
		got({
			timeout: {request: 1},
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'request\' for 1ms'
		}
	);
});

test('socket timeout', withServer, async (t, server, got) => {
	server.get('/', defaultHandler(got));

	await t.throwsAsync(
		got({
			timeout: {socket: 1},
			retry: 0
		}),
		{
			instanceOf: got.TimeoutError,
			code: 'ETIMEDOUT',
			message: 'Timeout awaiting \'socket\' for 1ms'
		}
	);
});

test('send timeout', withServer, async (t, server, got) => {
	server.get('/', defaultHandler(got));

	await t.throwsAsync(
		got({
			timeout: {send: 1},
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'send\' for 1ms'
		}
	);
});

test('send timeout (keepalive)', withServer, async (t, server, got) => {
	server.post('/', defaultHandler(got));
	server.get('/prime', (_request, response) => {
		response.end('ok');
	});

	await got('prime', {agent: keepAliveAgent});

	const body = new PassThrough();
	await t.throwsAsync(
		got.post({
			agent: keepAliveAgent,
			timeout: {send: 1},
			retry: 0,
			body
		}).on('request', request => {
			request.once('socket', socket => {
				t.false(socket.connecting);
				socket.once('connect', () => {
					t.fail('\'connect\' event fired, invalidating test');
				});
			});
			slowDataStream(got).pipe(body);
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'send\' for 1ms'
		}
	);
});

test('response timeout', withServer, async (t, server, got) => {
	server.get('/', defaultHandler(got));

	await t.throwsAsync(
		got({
			timeout: {response: 1},
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'response\' for 1ms'
		}
	);
});

test('response timeout unaffected by slow upload', withServer, async (t, server, got) => {
	server.post('/', defaultHandler(got));

	const body = new PassThrough();
	await t.notThrowsAsync(got.post({
		timeout: {response: requestDelay * 2},
		retry: 0,
		body
	}).on('request', () => {
		slowDataStream(got).pipe(body);
	}));
});

test('response timeout unaffected by slow download', withServer, async (t, server, got) => {
	server.get('/', downloadHandler(got));

	await t.notThrowsAsync(got({
		timeout: {response: requestDelay * 2},
		retry: 0
	}));
});

test('response timeout (keepalive)', withServer, async (t, server, got) => {
	server.get('/', defaultHandler(got));
	server.get('/prime', (_request, response) => {
		response.end('ok');
	});

	await got('prime', {agent: keepAliveAgent});

	const request = got({
		agent: keepAliveAgent,
		timeout: {response: 1},
		retry: 0
	}).on('request', request => {
		request.once('socket', socket => {
			t.false(socket.connecting);
			socket.once('connect', () => {
				t.fail('\'connect\' event fired, invalidating test');
			});
		});
	});

	await t.throwsAsync(request, {
		...errorMatcher,
		message: 'Timeout awaiting \'response\' for 1ms'
	});
});

test('connect timeout', withServer, async (t, server, got) => {
	server.get('/', defaultHandler(got));

	await t.throwsAsync(
		got({
			createConnection: options => {
				const socket = new net.Socket(options);
				// @ts-ignore
				socket.connecting = true;
				setImmediate(
					socket.emit.bind(socket),
					'lookup',
					null,
					'127.0.0.1',
					4,
					'localhost'
				);
				setImmediate(() => got.tickTimers(requestDelay + 1));
				return socket;
			},
			timeout: {connect: 1},
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'connect\' for 1ms'
		}
	);
});

test('connect timeout (ip address)', withServer, async (t, server, got) => {
	server.get('/', defaultHandler(got));

	await t.throwsAsync(
		got({
			hostname: '127.0.0.1',
			createConnection: options => {
				const socket = new net.Socket(options);
				// @ts-ignore
				socket.connecting = true;
				setImmediate(() => got.tickTimers(requestDelay + 1));
				return socket;
			},
			timeout: {connect: 1},
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'connect\' for 1ms'
		}
	);
});

test('secureConnect timeout', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	await t.throwsAsync(
		got.secure({
			timeout: {secureConnect: 0},
			retry: 0,
			rejectUnauthorized: false
		}).on('request', request => {
			request.on('socket', socket => {
				socket.on('connect', async () => {
					await got.tickTimers(10);
				});
			});
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'secureConnect\' for 0ms'
		}
	);
});

test('secureConnect timeout not breached', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const secureConnect = 200;
	await t.notThrowsAsync(got({
		timeout: {secureConnect},
		retry: 0,
		rejectUnauthorized: false
	}));
});

test('lookup timeout', withServer, async (t, server, got) => {
	server.get('/', defaultHandler(got));

	await t.throwsAsync(
		got({
			lookup: () => setImmediate(() => got.tickTimers(requestDelay)),
			timeout: {lookup: 1},
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'lookup\' for 1ms'
		}
	);
});

test('lookup timeout no error (ip address)', withServer, async (t, server, got) => {
	server.get('/', defaultHandler(got));

	await t.notThrowsAsync(got({
		hostname: '127.0.0.1',
		lookup: () => {},
		timeout: {lookup: 1},
		retry: 0
	}));
});

test('lookup timeout no error (keepalive)', withServer, async (t, server, got) => {
	server.get('/', defaultHandler(got));
	server.get('/prime', (_request, response) => {
		response.end('ok');
	});

	await got('prime', {agent: keepAliveAgent});
	await t.notThrowsAsync(got({
		agent: keepAliveAgent,
		timeout: {lookup: 1},
		retry: 0
	}).on('request', request => {
		request.once('connect', () => {
			t.fail('connect event fired, invalidating test');
		});
	}));
});

test('retries on timeout', withServer, async (t, server, got) => {
	server.get('/', defaultHandler(got));

	let tried = false;
	await t.throwsAsync(got({
		timeout: 1,
		retry: {
			calculateDelay: () => {
				if (tried) {
					return 0;
				}

				tried = true;
				return 1;
			}
		}
	}), {
		...errorMatcher,
		message: 'Timeout awaiting \'request\' for 1ms'
	});

	t.true(tried);
});

test('timeout with streams', withServer, async (t, server, got) => {
	server.get('/', defaultHandler(got));

	const stream = got.stream({
		timeout: 0,
		retry: 0
	});
	await t.throwsAsync(() => pEvent(stream, 'response'), {code: 'ETIMEDOUT'});
});

test('no error emitted when timeout is not breached (stream)', withServer, async (t, server, got) => {
	server.get('/', defaultHandler(got));

	const stream = got.stream({
		retry: 0,
		timeout: {
			request: requestDelay * 2
		}
	});

	await t.notThrowsAsync(getStream(stream));
});

test('no error emitted when timeout is not breached (promise)', withServer, async (t, server, got) => {
	server.get('/', defaultHandler(got));

	await t.notThrowsAsync(got({
		retry: 0,
		timeout: {
			request: requestDelay * 2
		}
	}));
});

// Note: sometimes `got()` resolves instead of rejecting. That's because Travis is slow.
test('no unhandled `socket hung up` errors', withServer, async (t, server, got) => {
	server.get('/', defaultHandler(got));
	await t.throwsAsync(got({retry: 0, timeout: requestDelay / 2}), {instanceOf: got.TimeoutError});
});

test('no more timeouts after an error', withServer, async (t, _, got) => {
	await t.throwsAsync(got(`http://${Date.now()}.dev`, {
		retry: 1,
		timeout: {
			lookup: 1,
			connect: 1,
			secureConnect: 1,
			socket: 1,
			response: 1,
			send: 1,
			request: 1
		}
	}), {instanceOf: got.GotError}); // Don't check the message, because it may throw ENOTFOUND before the timeout.

	// Wait a bit more to check if there are any unhandled errors
	// @ts-ignore
	await got.tickTimers(100);
});

test('socket timeout is canceled on error', withServer, async (t, server, got) => {
	server.get('/', defaultHandler(got));

	const message = 'oh, snap!';

	const promise = got({
		timeout: {socket: 100},
		retry: 0
	}).on('request', request => {
		request.emit('error', new Error(message));
		request.abort();
	});

	await t.throwsAsync(promise, {message});

	// Wait a bit more to check if there are any unhandled errors
	await got.tickTimers(100);
});

test('no memory leak when using socket timeout and keepalive agent', withServer, async (t, server, got) => {
	server.get('/', defaultHandler(got));

	const promise = got({
		agent: keepAliveAgent,
		timeout: {socket: requestDelay * 2}
	});

	let socket;
	promise.on('request', request => {
		request.on('socket', () => {
			socket = request.socket;
		});
	});

	await promise;

	t.is(socket.listenerCount('timeout'), 0);
});

test('ensure there are no new timeouts after cancelation', t => {
	const emitter = new EventEmitter();
	const socket = new EventEmitter();
	(socket as any).connecting = true;

	timedOut(emitter as http.ClientRequest, {
		connect: 1
	}, {
		hostname: '127.0.0.1'
	})();

	emitter.emit('socket', socket);
	socket.emit('lookup', null);
	t.is(socket.listenerCount('connect'), 0);
});

test('double calling timedOut has no effect', t => {
	const emitter = new EventEmitter();

	const attach = () => timedOut(emitter as http.ClientRequest, {
		connect: 1
	}, {
		hostname: '127.0.0.1'
	});

	attach();
	attach();

	t.is(emitter.listenerCount('socket'), 1);
});

test('doesn\'t throw on early lookup', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	await t.notThrowsAsync(got('', {
		timeout: {
			lookup: 100
		},
		retry: 0,
		lookup: (_hostname, options, callback) => {
			if (typeof options === 'function') {
				callback = options;
			}

			callback(null, '127.0.0.1', 4);
		}
	}));
});
