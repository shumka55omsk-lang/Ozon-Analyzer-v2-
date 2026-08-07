const sleep = ms => new Promise(r => setTimeout(r, ms));

function waitForTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(new Error('Карточка Ozon загружалась слишком долго')), timeoutMs);
    function finish(err, tab) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (err) reject(err); else resolve(tab);
    }
    function onUpdated(id, info, tab) {
      if (id !== tabId) return;
      if (info.status === 'complete') finish(null, tab);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError) return;
      if (tab?.status === 'complete') finish(null, tab);
    });
  });
}

async function sendExtract(tabId) {
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: 'OZON_EXTRACT_PAGE' });
      if (result?.ok) return result;
      if (result?.error) lastErr = new Error(result.error);
    } catch (e) {
      lastErr = e;
    }
    await sleep(900);
  }
  throw lastErr || new Error('Не удалось прочитать карточку Ozon');
}

async function fetchViaRealBrowser(url) {
  const parsed = new URL(url);
  if (!/(^|\.)ozon\.ru$/i.test(parsed.hostname)) throw new Error('Нужна ссылка ozon.ru');

  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    const loaded = await waitForTabComplete(tab.id);
    const finalUrl = loaded?.url || url;
    if (!/(^|\.)ozon\.ru$/i.test(new URL(finalUrl).hostname)) {
      throw new Error('Ozon перенаправил на другую страницу');
    }
    await sleep(1200);
    const extracted = await sendExtract(tab.id);
    return { ...extracted, finalUrl };
  } finally {
    if (tab?.id) {
      try { await chrome.tabs.remove(tab.id); } catch {}
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'OZON_FETCH_PRODUCT') {
    fetchViaRealBrowser(msg.url)
      .then(data => sendResponse({ ok: true, ...data }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg?.type === 'OZON_EXTENSION_PING') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
  }
});
