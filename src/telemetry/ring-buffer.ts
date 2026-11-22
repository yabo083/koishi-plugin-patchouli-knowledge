/**
 * Patchouli Knowledge — 定容环形缓冲区
 *
 * 用于遥测 trace 与基线账本事件：容量恒定、溢出按 FIFO 覆盖最旧条目，
 * 因此内存占用与运行时长无关（长时间挂机不会累积）。
 */

/** 默认容量（与全局 trace 预算一致）。 */
export const DEFAULT_RING_CAPACITY = 300;

/**
 * 定容环形缓冲区（FIFO 覆盖）。
 *
 * 实现为定长槽位 + 头指针：`push` 为 O(1)、不产生数组搬移；`toArray` 按
 * 「最旧 → 最新」输出副本，调用方对返回值做任何修改都不影响内部状态。
 */
export class RingBuffer<T> {
  private readonly slots: Array<T | undefined>;
  private head = 0;
  private count = 0;

  /**
   * @param capacity 容量，必须是正整数（非法值直接抛 RangeError，不做静默纠正）。
   */
  constructor(public readonly capacity: number = DEFAULT_RING_CAPACITY) {
    if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`[patchouli/telemetry] RingBuffer 容量必须是正整数，收到 ${String(capacity)}`);
    }
    this.slots = new Array<T | undefined>(capacity).fill(undefined);
  }

  /** 当前已存放的条目数（≤ capacity）。 */
  get size(): number {
    return this.count;
  }

  /** 是否已写满。 */
  get full(): boolean {
    return this.count === this.capacity;
  }

  /** 写入一条；写满时覆盖最旧条目。 */
  push(item: T): void {
    this.slots[(this.head + this.count) % this.capacity] = item;
    if (this.count < this.capacity) {
      this.count += 1;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /** 按「最旧 → 最新」导出副本。 */
  toArray(): T[] {
    const result = new Array<T>(this.count);
    for (let index = 0; index < this.count; index += 1) {
      result[index] = this.slots[(this.head + index) % this.capacity] as T;
    }
    return result;
  }

  /** 清空（容量不变）。 */
  clear(): void {
    this.slots.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}
