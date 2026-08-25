interface LegacyActionApi {
  enable(tabId?: number): void;
  disable(tabId?: number): void;
  setIcon(details: { imageData: ImageData; tabId?: number }): void;
}

type ChromeWithLegacyAction = typeof chrome & {
  browserAction?: LegacyActionApi;
};

export function getActionApi(): LegacyActionApi {
  const api = chrome as ChromeWithLegacyAction;
  const action = api.action ?? api.browserAction;
  if (!action) throw new Error("This browser does not provide an action API");
  return action;
}

export function queryActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tabs[0]);
    });
  });
}

export function getSyncStorage<T extends object>(defaults: T): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(defaults, (items) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(items as T);
    });
  });
}

export function setSyncStorage(items: object): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(items, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}
