type TauriWindow = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  startDragging: () => Promise<void>;
};

async function currentWindow(): Promise<TauriWindow | null> {
  try {
    const mod = await import("@tauri-apps/api/window");
    return mod.getCurrentWindow() as unknown as TauriWindow;
  } catch {
    return null;
  }
}

export async function windowMinimize(): Promise<void> {
  await (await currentWindow())?.minimize();
}

export async function windowToggleMaximize(): Promise<void> {
  await (await currentWindow())?.toggleMaximize();
}

export async function windowClose(): Promise<void> {
  await (await currentWindow())?.close();
}

export async function windowStartDragging(): Promise<void> {
  await (await currentWindow())?.startDragging();
}
