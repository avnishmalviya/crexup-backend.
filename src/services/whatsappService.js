/**
 * WhatsApp Business API integration.
 *
 * Real mode: sends via Meta's WhatsApp Business Cloud API.
 * Mock mode (default, USE_MOCK_WHATSAPP=true): logs the message and
 * returns a fake provider message id + SENT status so the rest of the
 * pipeline (status tracking, bulk send UI) can be developed/demoed without
 * a live WhatsApp Business account.
 */

const useMock = process.env.USE_MOCK_WHATSAPP !== "false";

function buildCampaignMessage({ creatorName, brandName, product, timeline, deliverables }) {
  return [
    `Hi ${creatorName},`,
    ``,
    `We'd love to collaborate with you for our latest campaign.`,
    ``,
    `Brand: ${brandName || "-"}`,
    `Product: ${product || "-"}`,
    `Timeline: ${timeline || "-"}`,
    `Deliverables: ${deliverables || "-"}`,
    ``,
    `Interested?`,
  ].join("\n");
}

async function sendWhatsappMessage({ toNumber, messageText }) {
  if (useMock) return mockSend({ toNumber, messageText });
  return realSend({ toNumber, messageText });
}

async function realSend({ toNumber, messageText }) {
  const token = process.env.WHATSAPP_API_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const baseUrl = process.env.WHATSAPP_API_BASE_URL || "https://graph.facebook.com/v19.0";

  if (!token || !phoneNumberId) {
    throw new Error(
      "WHATSAPP_API_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set. Set USE_MOCK_WHATSAPP=true to use mock sending."
    );
  }

  const res = await fetch(`${baseUrl}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toNumber,
      type: "text",
      text: { body: messageText },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp API error (${res.status}): ${body}`);
  }

  const data = await res.json();
  return {
    providerMessageId: data.messages?.[0]?.id || null,
    status: "SENT",
    sentAt: new Date(),
  };
}

async function mockSend({ toNumber, messageText }) {
  // eslint-disable-next-line no-console
  console.log(`[MOCK WHATSAPP] -> ${toNumber}:\n${messageText}\n`);
  await new Promise((r) => setTimeout(r, 50)); // simulate network latency
  return {
    providerMessageId: `mock_${Date.now()}_${Math.round(Math.random() * 1e6)}`,
    status: "SENT",
    sentAt: new Date(),
  };
}

module.exports = { buildCampaignMessage, sendWhatsappMessage };
