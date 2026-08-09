const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');

process.env.TRIM_API_TOKEN = 'test-token';

const trimApi = require('../src/trim-api');

async function runScenario(name, invoke = () => trimApi.callOpenApi(`test.${name}`)) {
  const originalRequest = http.request;
  let request;

  http.request = (_options, onResponse) => {
    request = new EventEmitter();
    request.setTimeout = (ms, callback) => {
      if (ms > 0) {
        request.timeoutMs = ms;
        request.timeoutCallback = callback;
      }
      return request;
    };
    request.write = () => {};
    request.destroy = (err) => {
      request.destroyed = true;
      if (err) queueMicrotask(() => request.emit('error', err));
    };
    request.end = () => {
      queueMicrotask(() => {
        if (name === 'timeout') {
          request.timeoutCallback();
          return;
        }
        if (name === 'transport-error') {
          request.emit('error', Object.assign(new Error('socket failed'), { code: 'ECONNRESET' }));
          return;
        }

        const response = new EventEmitter();
        response.statusCode = 200;
        response.complete = !['aborted', 'response-error'].includes(name);
        response.setEncoding = () => {};
        onResponse(response);

        if (name === 'aborted') {
          response.emit('aborted');
          // A late successful body must not replace the first rejection.
          response.emit('data', '{"code":0,"data":{"late":true}}');
          response.emit('end');
          return;
        }
        if (name === 'response-error') {
          response.emit('error', Object.assign(new Error('response failed'), { code: 'EPIPE' }));
          return;
        }

        let body;
        if (name === 'api-error') {
          body = { code: 200003, msg: 'scope denied', data: null };
        } else if (name === 'canonical-array') {
          body = {
            code: 0,
            msg: '',
            data: [
              {
                path: '/canonical/real.md',
                readable: true,
                writable: false,
                deletable: false,
              },
            ],
          };
        } else {
          body = { code: 0, msg: '', data: { ok: true } };
        }
        response.emit('data', JSON.stringify(body));
        response.emit('end');
        response.emit('close');
      });
    };
    return request;
  };

  try {
    return { value: await invoke(), request };
  } catch (error) {
    return { error, request };
  } finally {
    http.request = originalRequest;
  }
}

test('times out at 10s, destroys the request, and maps to 502', async () => {
  const result = await runScenario('timeout');
  assert.equal(result.error.code, 'OPEN_API_TIMEOUT');
  assert.equal(result.error.status, 502);
  assert.equal(result.request.timeoutMs, 10_000);
  assert.equal(result.request.destroyed, true);
});

test('handles aborted and errored responses once as 502', async () => {
  const aborted = await runScenario('aborted');
  assert.equal(aborted.error.code, 'OPEN_API_RESPONSE_ABORTED');
  assert.equal(aborted.error.status, 502);

  const responseError = await runScenario('response-error');
  assert.equal(responseError.error.code, 'EPIPE');
  assert.equal(responseError.error.status, 502);
});

test('maps transport and API non-zero errors to 502', async () => {
  const transport = await runScenario('transport-error');
  assert.equal(transport.error.code, 'ECONNRESET');
  assert.equal(transport.error.status, 502);

  const apiError = await runScenario('api-error');
  assert.equal(apiError.error.apiCode, 200003);
  assert.equal(apiError.error.status, 502);
});

test('returns successful OpenAPI data', async () => {
  const result = await runScenario('success');
  assert.deepEqual(result.value, { ok: true });
});

test('keeps the requested stable fd path when the API canonicalizes item.path', async () => {
  const requested = '/proc/1234/fd/9';
  const result = await runScenario('canonical-array', () =>
    trimApi.checkUserACL('1000', [requested]),
  );
  assert.equal(result.value[requested].readable, true);
  assert.equal(result.value['/canonical/real.md'].readable, true);
});
