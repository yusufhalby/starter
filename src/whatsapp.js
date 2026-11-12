function createWhatsAppSender(config, log = console) {
  if (config.dryRun) {
    return async (to, body) => {
      log.log(`[dry-run] WhatsApp -> ${to}: ${body}`);
      return { dryRun: true };
    };
  }

  const url = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;

  return async function sendWhatsAppText(to, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data?.error?.message || res.statusText;
      throw new Error(`WhatsApp send failed (${res.status}): ${msg}`);
    }
    return data;
  };
}

module.exports = { createWhatsAppSender };
