import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';

interface Release {
  id: string; version: string; digest: string; entry: string; styles: string[];
  assets: Record<string, string>; sourceSha: string;
}
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/1ioAAAAASUVORK5CYII=', 'base64');
export const fixtureImage = { name: 'synthetic.png', mimeType: 'image/png', buffer: image };
export async function realModules(page: Page) {
  const releases = JSON.parse(await readFile(resolve('node_modules/.cache/assistant-browser/real-modules.json'), 'utf8')) as Release[];
  const uploads: { name: string; bytes: number; method: string }[] = [];
  const speechSessions: string[] = [];
  const requests: string[] = [];
  const assets: string[] = [];
  const files = new Map<string, Buffer>();
  await page.route('**/_modules', async route => {
    const response = await route.fetch();
    const manifest = await response.json() as { modules: unknown[] };
    manifest.modules.push(...releases.map(release => ({
      id: release.id, name: release.id, version: release.version, digest: release.digest,
      entry: `/_modules/assets/${release.id}/${release.digest}/${release.entry}`,
      styles: release.styles.map(path => `/_modules/assets/${release.id}/${release.digest}/${path}`),
      apiBase: `/_modules/${release.id}/${release.digest}/api`,
      config: release.id === 'cockpit-file' ? { nativePathPrefix: '/synthetic/managed/' } : {},
    })));
    await route.fulfill({ json: manifest });
  });
  await page.route('**/_modules/assets/cockpit-*/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const release = releases.find(value => path.startsWith(`/_modules/assets/${value.id}/${value.digest}/`));
    const relative = release && path.slice(`/_modules/assets/${release.id}/${release.digest}/`.length);
    const asset = release && relative && release.assets[relative];
    if (!asset) throw new Error(`Unrecognized real release asset ${path}`);
    assets.push(path);
    await route.fulfill({ path: asset, contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
  });
  await page.route('**/_modules/cockpit-*/**/api/**', async route => {
    const url = new URL(route.request().url());
    requests.push(`${route.request().method()} ${url.pathname}`);
    if (url.pathname.endsWith('/upload')) {
      const name = url.searchParams.get('name')!;
      const bytes = route.request().postDataBuffer()!;
      uploads.push({ name, bytes: bytes.length, method: route.request().method() });
      const fileId = `f_${String(uploads.length).padStart(64, '0')}`;
      files.set(fileId, bytes);
      await route.fulfill({ json: { fileId, attachment: {
        type: 'file', path: `/synthetic/managed/${fileId}/ready/body.png`, displayName: name,
      } } });
    } else if (/\/files\/f_[a-f0-9]{64}\/body\.png$/.test(url.pathname)) {
      const data = files.get(url.pathname.split('/').at(-2)!)!;
      await route.fulfill({ contentType: 'image/png', headers: { 'content-length': String(data.length) },
        body: route.request().method() === 'HEAD' ? Buffer.alloc(0) : data });
    } else if (/\/uploads\//.test(url.pathname) && route.request().method() === 'DELETE') {
      await route.fulfill({ status: 204 });
    } else if (url.pathname.endsWith('/session')) {
      speechSessions.push(route.request().postData()!);
      await route.fulfill({ json: { clientSecret: 'synthetic-only', expiresAt: Math.floor(Date.now() / 1000) + 600,
        deployment: 'synthetic-transcription', socketUrl: 'wss://synthetic.openai.azure.com/openai/v1/realtime?intent=transcription' } });
    } else throw new Error(`Unexpected real module fixture request ${url.pathname}`);
  });
  await page.addInitScript(() => {
    const state = window.fixtureAudio = { starts: 0, stopped: 0, sockets: 0, frames: [] as string[] };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      async getUserMedia() {
        state.starts++;
        const track = { readyState: 'live', stop() { state.stopped++; this.readyState = 'ended'; } };
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      },
    } });
    class AudioContextMock {
      state = 'running'; destination = {}; onstatechange = null;
      audioWorklet = { addModule: async () => {} };
      async resume() {} async close() { this.state = 'closed'; }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    }
    class WorkletMock {
      onprocessorerror = null;
      port = {
        onmessage: null as null | ((event: { data: unknown }) => void),
        close() {},
        postMessage: (data: { type: string }) => {
          if (data.type === 'stop') queueMicrotask(() => {
            this.port.onmessage?.({ data: { type: 'pcm', buffer: new Int16Array(2400).buffer } });
            this.port.onmessage?.({ data: { type: 'ended', limited: false } });
          });
        },
      };
      connect() {} disconnect() {}
    }
    class SocketMock {
      bufferedAmount = 0;
      onopen: null | (() => void) = null;
      onmessage: null | ((event: { data: string }) => void) = null;
      onerror = null; onclose = null;
      constructor(url: string) {
        if (!url.startsWith('wss://synthetic.openai.azure.com/')) throw new Error('External socket forbidden');
        state.sockets++;
        setTimeout(() => this.onopen?.(), 0);
      }
      emit(data: unknown) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(data) })); }
      send(text: string) {
        const data = JSON.parse(text);
        state.frames.push(data.type);
        if (data.type === 'session.update') this.emit({ type: 'session.updated', session: data.session });
        if (data.type === 'input_audio_buffer.commit') {
          this.emit({ type: 'input_audio_buffer.committed', item_id: 'synthetic-voice', previous_item_id: null });
          this.emit({ type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'synthetic-voice', content_index: 0, transcript: '真实 Speech 插件的合成语音' });
        }
        if (data.type === 'input_audio_buffer.clear') this.emit({ type: 'input_audio_buffer.cleared' });
      }
      close() {}
    }
    Object.defineProperties(window, {
      AudioContext: { value: AudioContextMock }, AudioWorkletNode: { value: WorkletMock },
      WebSocket: { value: SocketMock },
    });
  });
  return { releases, uploads, speechSessions, requests, assets };
}

declare global {
  interface Window {
    fixtureAudio: { starts: number; stopped: number; sockets: number; frames: string[] };
  }
}
