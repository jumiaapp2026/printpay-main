const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;
const STK_PUSH_URL = 'https://printpay.co.ke/api/stk_push';

app.use(express.json({ limit: '1mb' }));

function logRender(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === 'ERROR' || level === 'WARN') {
    console.error(line);
  } else {
    console.log(line);
  }
}

// Capture unhandled process errors so Render Logs always record them
process.on('uncaughtException', (err) => {
  logRender('ERROR', 'Uncaught exception', {
    error: err.message,
    stack: err.stack,
  });
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logRender('ERROR', 'Unhandled promise rejection', {
    error: err.message,
    stack: err.stack,
  });
});

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D+/g, '');
  if (!digits) return null;

  if (digits.startsWith('254') && digits.length === 12) {
    return digits;
  }
  if ((digits.startsWith('07') || digits.startsWith('01')) && digits.length === 10) {
    return `254${digits.slice(1)}`;
  }
  if ((digits.startsWith('7') || digits.startsWith('1')) && digits.length === 9) {
    return `254${digits}`;
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendStkPush(apiKey, phoneNumber, amount) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  const formBody = new URLSearchParams({
    x_api_key: apiKey,
    phone_number: phoneNumber,
    amount: String(amount),
  });

  try {
    const res = await fetch(STK_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json, text/plain, */*',
      },
      body: formBody.toString(),
      signal: controller.signal,
    });

    const rawText = await res.text();
    let parsedJson = null;
    try {
      parsedJson = JSON.parse(rawText);
    } catch (_) {
      parsedJson = null;
    }

    return {
      ok: res.ok,
      status: res.status,
      rawText,
      json: parsedJson,
    };
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/bulk-stk', async (req, res) => {
  const apiKey = process.env.PRINTPAY_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    logRender('ERROR', 'PRINTPAY_API_KEY environment variable is missing or empty');
    return res.status(500).json({
      ok: false,
      error: 'Server configuration error: PRINTPAY_API_KEY is not set.',
    });
  }

  const amount = Number(req.body?.amount);
  const phones = req.body?.phones;

  if (!Number.isInteger(amount) || amount < 1) {
    logRender('WARN', 'Invalid amount submitted to /api/bulk-stk', { amount: req.body?.amount });
    return res.status(400).json({
      ok: false,
      error: 'Amount must be a whole number of at least 1.',
    });
  }

  if (!Array.isArray(phones) || phones.length === 0) {
    logRender('WARN', 'Empty or non-array phones list submitted to /api/bulk-stk');
    return res.status(400).json({
      ok: false,
      error: 'Please enter at least one phone number.',
    });
  }

  const batchId = `stk_${crypto.randomBytes(4).toString('hex')}`;
  const results = [];

  logRender('INFO', 'Starting bulk STK Push batch', {
    batchId,
    totalItems: phones.length,
    amount,
    intervalSeconds: 3,
  });

  for (let i = 0; i < phones.length; i++) {
    const rawEntry = String(phones[i] ?? '').trim();
    if (!rawEntry) continue;

    const normalized = normalizePhone(rawEntry);
    if (!normalized) {
      logRender('WARN', 'Skipping invalid phone number', {
        batchId,
        index: i,
        input: rawEntry,
      });
      results.push({
        input: rawEntry,
        phone: null,
        status: 'invalid_phone',
        detail: 'Could not normalize to a valid 254XXXXXXXXX number.',
      });
    } else {
      logRender('INFO', 'Dispatching STK Push', {
        batchId,
        step: i + 1,
        of: phones.length,
        phone: normalized,
        amount,
      });

      try {
        const apiRes = await sendStkPush(apiKey.trim(), normalized, amount);
        const payload = apiRes.json ?? apiRes.rawText;

        if (apiRes.ok) {
          logRender('INFO', 'STK Push accepted by gateway', {
            batchId,
            phone: normalized,
            httpStatus: apiRes.status,
            response: payload,
          });
          results.push({
            input: rawEntry,
            phone: normalized,
            status: 'sent',
            httpStatus: apiRes.status,
            response: payload,
          });
        } else {
          logRender('ERROR', 'STK Push rejected by gateway', {
            batchId,
            phone: normalized,
            httpStatus: apiRes.status,
            response: payload,
          });
          results.push({
            input: rawEntry,
            phone: normalized,
            status: 'api_error',
            httpStatus: apiRes.status,
            response: payload,
          });
        }
      } catch (err) {
        logRender('ERROR', 'Request failed while sending STK Push', {
          batchId,
          phone: normalized,
          error: err.message,
          name: err.name,
        });
        results.push({
          input: rawEntry,
          phone: normalized,
          status: 'exception',
          detail: err.message,
        });
      }
    }

    if (i < phones.length - 1) {
      await sleep(3000);
    }
  }

  logRender('INFO', 'Completed bulk STK Push batch', {
    batchId,
    processed: results.length,
  });

  return res.json({
    ok: true,
    batchId,
    results,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  logRender('INFO', 'Bulk STK Push bot server started', {
    port: Number(PORT),
    nodeVersion: process.version,
  });
});
