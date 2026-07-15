import assert from 'node:assert/strict';
import worker from './cloudflare-worker.mjs';

const calls = [];
globalThis.fetch = async function (url, options) {
  calls.push({
    url: String(url),
    method: options.method,
    redirect: options.redirect,
  });

  if (calls.length === 1) {
    return new Response('', {
      status: 302,
      headers: { location: 'https://script.googleusercontent.com/test' },
    });
  }
  return new Response('OK', { status: 200 });
};

const request = new Request('https://worker.test', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"events":[]}',
});
const response = await worker.fetch(request, {
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/test/exec',
}, {});

assert.equal(response.status, 200);
assert.equal(await response.text(), 'OK');
assert.equal(calls.length, 1);
assert.equal(calls[0].method, 'POST');
assert.equal(calls[0].redirect, 'manual');
console.log('Worker Apps Script redirect test: OK');
