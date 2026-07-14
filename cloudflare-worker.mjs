const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

      let finalResponse = firstResponse;
      if (REDIRECT_STATUSES.has(firstResponse.status)) {
        const location = firstResponse.headers.get('location');
        if (!location) throw new Error('Apps Script redirect did not include a Location header.');
        finalResponse = await fetch(location, {
          method: 'POST',
          headers,
          body: body.slice(0),
          redirect: 'follow',
        });
      }

      if (!finalResponse.ok) {
        const errorText = await finalResponse.text();
        console.error('Apps Script error', finalResponse.status, errorText);
        return new Response('Upstream error', { status: 502 });
      }

      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('Webhook proxy error', error);
      return new Response('Proxy error', { status: 502 });
    }
  },
};
