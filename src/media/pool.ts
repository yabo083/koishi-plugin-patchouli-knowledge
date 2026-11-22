/**
 * 卡片素材池：背景图与一言的「生产者 / 消费者」缓冲。
 *
 * 生产与消费**只通过固定目录交互**，两边互不 import：
 *   <dir>/<kind>/pending/<seq>-<rand>.<ext>   可被消费的素材（FIFO）
 *   <dir>/<kind>/used/<seq>-<rand>.<ext>      离线模式下已消费、冷却中的素材
 *
 * - 生产方（`ensureFilled`）：可用水位低于 `lowWater` 时抓一批补到 `batch` 之上。
 * - 消费方（`take`）：取最早一个；在线模式读完即删，离线模式移入 `used/`。
 * - 环形回收（`sweep`）：`used/` 里超过 `cooldownMs` 的素材改名回 `pending/`，
 *   于是同一批素材会被反复轮转——离线时没有网络也能持续出图。
 *
 * 一切失败（网络、解析、磁盘）都不抛：素材池是增强项，缺料时调用方回退到无图卡片。
 */

import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/** 素材种类：长图底图 / 页尾一言。 */
export type MediaKind = 'image' | 'saying';

/** 素材池读写参数（由插件配置派生）。 */
export interface MediaPoolConfig {
  /** 素材根目录；空串表示禁用素材池。 */
  dir: string;
  /** 离线模式：不抓新素材，已消费素材冷却后回收复用。 */
  offline: boolean;
  /** 水位：可用素材低于该值时补货。 */
  lowWater: number;
  /** 单次补货条数。 */
  batch: number;
  /** 离线模式下已消费素材的冷却时长（毫秒）。 */
  cooldownMs: number;
  /** 底图来源（HTTP(S)，允许 302）。 */
  imageSource: string;
  /** 一言来源（HTTP(S)，返回 JSON `{ text }`）。 */
  sayingSource: string;
  /**
   * 可选的来源密钥；空串表示匿名调用（公开端点不需要）。
   * 只作为 `key` 查询参数拼进请求 URL，不落盘、不进日志、不进渲染产物。
   */
  apiKey?: string;
}

/** 目录两侧的用量快照。 */
export interface MediaPoolStats {
  pending: number;
  used: number;
}

/** 抓取超时（毫秒）。 */
const FETCH_TIMEOUT_MS = 15_000;
/** 单张底图体积上限。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 一言入库长度上限（字符）。 */
const MAX_SAYING_CHARS = 120;

const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** 文件名排序即 FIFO：固定 13 位毫秒时间戳前缀。 */
function stamp(at = Date.now()): string {
  return String(at).padStart(13, '0');
}

function noop(): void {
  /* intentionally empty */
}

function nonce(): string {
  return randomBytes(4).toString('hex');
}

/** 带超时的 `fetch`（跟随重定向）。 */
/**
 * 读取响应体，累计超过 `limit` 字节立即取消并返回 `undefined`。
 *
 * 不提供流（测试桩 / 老运行时）时退回 `arrayBuffer()`，但仍做一次大小检查。
 */
async function readBoundedBody(response: Response, limit: number): Promise<Buffer | undefined> {
  const stream = response.body;
  if (stream === null || stream === undefined || typeof stream.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength <= limit ? buffer : undefined;
  }
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch((): undefined => undefined);
        return undefined;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchWithTimeout(url: string): Promise<Response | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'patchouli-knowledge/media-pool' },
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}

export class MediaPool {
  private readonly config: MediaPoolConfig;
  /**
   * 运行期计数器（只增不减，进程内）。
   *
   * `failed` 是**抓取失败次数**：上游抖动会被静默跳过，没有这个数字就只能靠 `ls` 数文件；
   * `swept` 是离线模式环形回收的次数。两项都不落盘——它们回答「今天顺不顺」，
   * 而不是「账对不对」，需要精确账目时看目录本身。
   */
  private readonly counters = { produced: 0, failed: 0, consumed: 0, swept: 0 };
  /** 正在补货的种类：同一时刻只允许一个填充任务。 */
  private readonly filling = new Set<MediaKind>();
  /**
   * 每种素材的消费队列：`take` 的「列目录 → 读 → 出队」三步必须整体互斥。
   *
   * 两个群同时结算时若各自 list 到同一个文件，后到者的出队失败被吞，两张卡就会
   * 共用同一张图、`consumed` 还双记。这里与 `LocalStore.serialize` 同构：串行排队。
   *
   * 作用域是**进程内**：素材目录按实例配置，跨实例共享同一目录不在保证范围内。
   */
  private readonly takeQueue: Record<MediaKind, Promise<void>> = {
    image: Promise.resolve(),
    saying: Promise.resolve(),
  };

  public constructor(config: MediaPoolConfig) {
    this.config = config;
  }

  /** 素材池是否可用（目录已配置）。 */
  public get enabled(): boolean {
    return this.config.dir.trim() !== '';
  }

  /**
   * 给来源 URL 附加可选的 `key` 参数。
   *
   * 用 `URL` 而不是字符串拼接，保留既有查询串；来源 URL 非法时原样返回，
   * 由 `fetch` 自己去失败（补货失败只表现为不补货）。
   */
  private authUrl(source: string): string {
    const key = (this.config.apiKey ?? '').trim();
    if (key === '') return source;
    try {
      const url = new URL(source);
      if (!url.searchParams.has('key')) url.searchParams.set('key', key);
      return url.toString();
    } catch {
      return source;
    }
  }

  private kindDir(kind: MediaKind, side: 'pending' | 'used'): string {
    return join(this.config.dir, kind, side);
  }

  /** 目录不存在时静默创建。 */
  private async ensureDir(path: string): Promise<boolean> {
    try {
      await mkdir(path, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  private async list(kind: MediaKind, side: 'pending' | 'used'): Promise<string[]> {
    try {
      const entries = await readdir(this.kindDir(kind, side));
      return entries.filter((name) => !name.startsWith('.')).sort();
    } catch {
      return [];
    }
  }

  /** 运行期计数器快照（只读）。 */
  public get metrics(): Readonly<typeof this.counters> {
    return { ...this.counters };
  }

  /** 两侧用量（`/api/media` 与测试使用）。 */
  public async stats(kind: MediaKind): Promise<MediaPoolStats> {
    return { pending: (await this.list(kind, 'pending')).length, used: (await this.list(kind, 'used')).length };
  }

  /**
   * 环形回收：把 `used/` 里冷却结束的素材改名回 `pending/`。
   *
   * 只有离线模式需要它——在线模式消费即删除，`used/` 恒为空。
   * 返回本次回收条数。
   */
  public async sweep(kind: MediaKind, now = Date.now()): Promise<number> {
    if (!this.config.offline) return 0;
    const usedDir = this.kindDir(kind, 'used');
    const pendingDir = this.kindDir(kind, 'pending');
    if (!(await this.ensureDir(pendingDir))) return 0;
    let restored = 0;
    for (const name of await this.list(kind, 'used')) {
      const from = join(usedDir, name);
      try {
        const info = await stat(from);
        // 冷却以**消费时刻**为锚：`take` 落 `used/` 前会用 `utimes` 刷新 mtime。
        // 素材的生产时刻通常早于消费好几小时，按它判冷却等于刚消费就能立刻回收。
        if (now - info.mtimeMs < this.config.cooldownMs) continue;
        const ext = name.slice(name.lastIndexOf('.'));
        await rename(from, join(pendingDir, `${stamp()}-${nonce()}${ext}`));
        restored += 1;
        this.counters.swept += 1;
      } catch {
        // 文件被并发消费或已消失，忽略。
      }
    }
    return restored;
  }

  /**
   * 消费一个素材。
   *
   * - `image`：返回可直接内嵌 HTML 的 `data:` URI；
   * - `saying`：返回文本（已裁剪换行与首尾空白）。
   *
   * 没有可用素材时返回 `undefined`，调用方回退到无素材版式。
   * 消费成功后异步补货，**不阻塞调用方**。
   */
  public async take(kind: MediaKind): Promise<string | undefined> {
    if (!this.enabled) return undefined;
    // 消费必须整体串行：`list` 到出队之间并发，会让两个消费者看到同一个文件。
    return this.serializeTake(kind, () => this.takePending(kind));
  }

  /** 把一次消费排进该种类的队列；前一次失败不影响后续。 */
  private serializeTake(
    kind: MediaKind,
    task: () => Promise<string | undefined>,
  ): Promise<string | undefined> {
    const run = this.takeQueue[kind].then(task, task);
    this.takeQueue[kind] = run.then(noop, noop);
    return run;
  }

  private async takePending(kind: MediaKind): Promise<string | undefined> {
    await this.sweep(kind);
    const pendingDir = this.kindDir(kind, 'pending');
    const names = await this.list(kind, 'pending');
    if (names.length === 0) {
      void this.ensureFilled(kind);
      return undefined;
    }
    const name = names[0];
    const path = join(pendingDir, name);
    const payload = await this.readPayload(kind, path, name);
    const consumedAt = Date.now();
    try {
      if (this.config.offline) {
        const usedDir = this.kindDir(kind, 'used');
        await this.ensureDir(usedDir);
        const ext = name.slice(name.lastIndexOf('.'));
        // 冷却锚点是**消费时刻**：改名沿用生产 mtime，所以文件名与 mtime 都要刷新。
        const target = join(usedDir, `${stamp(consumedAt)}-${nonce()}${ext}`);
        await rename(path, target);
        await utimes(target, consumedAt / 1000, consumedAt / 1000);
      } else {
        await unlink(path);
      }
    } catch {
      // 出队失败不影响本次返回（读失败的文件同样要出队，否则会永久堵在最前面）。
    }

    if (payload !== undefined && payload !== '') this.counters.consumed += 1;
    void this.ensureFilled(kind);
    return payload === '' ? undefined : payload;
  }

  /** 读出素材内容（图片转 data URI，一言取裁剪文本）；不可读返回 `undefined`。 */
  private async readPayload(kind: MediaKind, path: string, name: string): Promise<string | undefined> {
    try {
      if (kind === 'image') {
        const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
        const mime = IMAGE_MIME[ext];
        if (mime === undefined) return undefined;
        // base64 会把体积放大 4/3 并整体驻留：先按文件大小拒绝，再读。
        const info = await stat(path).catch((): undefined => undefined);
        if (info === undefined || info.size > MAX_IMAGE_BYTES) return undefined;
        return `data:${mime};base64,${(await readFile(path)).toString('base64')}`;
      }
      return (await readFile(path, 'utf8')).trim();
    } catch {
      return undefined;
    }
  }

  /**
   * 补货到水位之上。
   *
   * 离线模式直接返回 0（不触网）；同一时刻每种素材只有一个任务在跑。
   * 返回本次新增条数。
   */
  public async ensureFilled(kind: MediaKind): Promise<number> {
    if (!this.enabled || this.config.offline) return 0;
    if ((kind === 'image' ? this.config.imageSource : this.config.sayingSource).trim() === '') return 0;
    // 单飞必须在**任何 await 之前**置位：`take` 的后台补货、定时器与显式调用可能同时到达，
    // 放到 `list()` 之后就会双双通过闸门，各抓一整批。
    if (this.filling.has(kind)) return 0;
    this.filling.add(kind);
    try {
      const pending = await this.list(kind, 'pending');
      if (pending.length >= this.config.lowWater) return 0;

      const target = Math.max(this.config.batch, this.config.lowWater - pending.length);
      const pendingDir = this.kindDir(kind, 'pending');
      if (!(await this.ensureDir(pendingDir))) return 0;
      const existing = kind === 'saying' ? await this.existingSayings(pendingDir, pending) : new Set<string>();
      let added = 0;
      for (let index = 0; index < target; index += 1) {
        const ok = kind === 'image'
          ? await this.produceImage(pendingDir)
          : await this.produceSaying(pendingDir, existing);
        if (ok) {
          added += 1;
          this.counters.produced += 1;
        } else {
          this.counters.failed += 1;
        }
      }
      return added;
    } finally {
      this.filling.delete(kind);
    }
  }

  /** 已有一言的正文集合：避免补货时写入重复句子。 */
  private async existingSayings(dir: string, names: readonly string[]): Promise<Set<string>> {
    const seen = new Set<string>();
    for (const name of names) {
      try {
        seen.add((await readFile(join(dir, name), 'utf8')).trim());
      } catch {
        // 忽略不可读文件。
      }
    }
    return seen;
  }

  /** 抓一张底图落盘。 */
  private async produceImage(dir: string): Promise<boolean> {
    const response = await fetchWithTimeout(this.authUrl(this.config.imageSource));
    if (response === undefined || !response.ok) return false;
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const ext = type.split('/')[1] ?? '';
    if (!type.startsWith('image/') || IMAGE_MIME[ext] === undefined) return false;
    try {
      // 先看声明长度：一次 32MB 响应整体 materialize 后再判限会把瞬时堆推到 +96MB。
      const declared = Number(response.headers.get('content-length') ?? Number.NaN);
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return false;
      // 分块累积到上限即中止：`arrayBuffer()` 会先把整段读进内存，对无 content-length 的
      // 分块响应（或读中增长的文件）等于没有上限。
      const buffer = await readBoundedBody(response, MAX_IMAGE_BYTES);
      if (buffer === undefined || buffer.byteLength === 0) return false;
      await writeFile(join(dir, `${stamp()}-${nonce()}.${ext}`), buffer);
      return true;
    } catch {
      return false;
    }
  }

  /** 抓一条一言落盘（去重 + 截断）。 */
  private async produceSaying(dir: string, existing: Set<string>): Promise<boolean> {
    const response = await fetchWithTimeout(this.authUrl(this.config.sayingSource));
    if (response === undefined || !response.ok) return false;
    try {
      const raw: unknown = await response.json();
      if (typeof raw !== 'object' || raw === null || !('text' in raw)) return false;
      const text = typeof raw.text === 'string' ? raw.text : '';
      const normalized = text.replace(/\s+/gu, ' ').trim().slice(0, MAX_SAYING_CHARS);
      if (normalized === '' || existing.has(normalized)) return false;
      existing.add(normalized);
      await writeFile(join(dir, `${stamp()}-${nonce()}.txt`), normalized, 'utf8');
      return true;
    } catch {
      return false;
    }
  }
}
