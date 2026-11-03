// Clicking the toolbar icon opens or closes the panel in the Meet tab.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !tab.url || !tab.url.startsWith('https://meet.google.com/')) return;
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => window.__meetMixer && window.__meetMixer.togglePanel(),
  });
});
