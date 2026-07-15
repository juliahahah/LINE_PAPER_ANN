export default {
  async fetch(request, env, context) {
    if (request.method === 'GET') {
      return new Response('PAPER CALL webhook proxy is running.', { status: 200 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (!env.APPS_SCRIPT_URL) {
      return new Response('APPS_SCRIPT_URL is not configured.', { status: 500 });
    }

    const body = await request.arrayBuffer();
    const contentType = request.headers.get('content-type') || 'application/json';
    const signature = request.headers.get('x-line-signature');
    const headers = { 'content-type': contentType };
    if (signature) headers['x-line-signature'] = signature;

    try {
      const firstResponse = await fetch(env.APPS_SCRIPT_URL, {
        method: 'POST',
        headers,
        body: body.slice(0),
        redirect: 'manual',
      });

      // Apps Script runs doPost() before it returns its unavoidable 302 redirect.
      // The redirect only serves the response body and must not receive the event again.
      if (!firstResponse.ok && firstResponse.status !== 302) {
        const errorText = await firstResponse.text();
        console.error('Apps Script error', firstResponse.status, errorText);
        return new Response('Upstream error', { status: 502 });
      }

      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('Webhook proxy error', error);
      return new Response('Proxy error', { status: 502 });
    }
  },
};
