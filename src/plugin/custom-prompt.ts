/**
 * Patchouli Knowledge - 自定义系统提示词持久化
 *
 * 提示词不再出现在 Koishi 配置表单里（表单只留 provider / model / temperature /
 * maxTokens / enableAutoTuning）：默认即内置最高品质的 `PATCHOULI_SYSTEM_PROMPT`。
 * 唯一的覆盖入口是悬浮窗设置页（`POST <base>/api/prompt`），覆盖结果必须跨服务
 * 重启存活，因此原子落盘到插件私有仓储：`<wikiDir>/.patchouli/custom-prompt.txt`。
 *
 * 本模块只负责这一个文件的读写；内存热更新由调用方（`PatchouliKnowledgeSystem`
 * 与 Web API）完成，路径推导复用 `src/wiki/layout.ts`。
 */

import { promises as fs } from 'node:fs';
import { dirname as dirnamePath } from 'node:path';
import { resolveWikiLayout } from '../wiki/layout';
import type { DispatcherConfig } from '../types';

/** 自定义提示词文件的绝对路径（纯路径运算，不做 I/O）。 */
export function resolveCustomPromptPath(wikiDir: string): string {
  return resolveWikiLayout(wikiDir).customPromptPath;
}

/**
 * 读取自定义提示词。文件不存在、内容为空或只含空白时一律返回空串
 * （= 使用内置帕秋莉提示词）；其余读取错误向上抛出，由调用方决定是否降级。
 */
export async function readCustomPromptFile(wikiDir: string): Promise<string> {
  try {
    const raw = await fs.readFile(resolveCustomPromptPath(wikiDir), 'utf8');
    return raw.trim().length > 0 ? raw : '';
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * 原子写入自定义提示词：先写同目录临时文件再 `rename`，进程中断绝不会留下半截提示词。
 * 空白内容等价于「恢复默认」：删除文件，而不是留下一份空文件。
 */
export async function writeCustomPromptFile(wikiDir: string, prompt: string): Promise<void> {
  const target = resolveCustomPromptPath(wikiDir);
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    await fs.rm(target, { force: true });
    return;
  }
  await fs.mkdir(dirnamePath(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, prompt, 'utf8');
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch((): undefined => undefined);
    throw error;
  }
}

/**
 * 「保存并应用」/「恢复默认」的唯一执行路径：**先落盘，再热更新实时配置**。
 * 落盘失败时内存保持原值，绝不出现「面板说生效、重启就丢」。
 */
export async function persistCustomPrompt(
  wikiDir: string,
  dispatcher: DispatcherConfig,
  prompt: string,
): Promise<void> {
  const raw = typeof prompt === 'string' ? prompt : '';
  // 仅含空白的内容一律收敛为空串：内存置空 + 删除落盘文件，绝不留下伪自定义副本。
  const next = raw.trim().length > 0 ? raw : '';
  await writeCustomPromptFile(wikiDir, next);
  dispatcher.customSystemPrompt = next;
}

/** 主题聚合自定义提示词文件的绝对路径。 */
export function resolveTopicPromptPath(wikiDir: string): string {
  return resolveWikiLayout(wikiDir).customTopicPromptPath;
}

/** 读取主题聚合自定义提示词；不存在 / 空白一律视为内置默认。 */
export async function readTopicPromptFile(wikiDir: string): Promise<string> {
  try {
    const raw = await fs.readFile(resolveTopicPromptPath(wikiDir), 'utf8');
    return raw.trim().length > 0 ? raw : '';
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return '';
    throw error;
  }
}

/** 原子写入主题聚合自定义提示词；空白内容等价于恢复默认（删除文件）。 */
export async function writeTopicPromptFile(wikiDir: string, prompt: string): Promise<void> {
  const target = resolveTopicPromptPath(wikiDir);
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    await fs.rm(target, { force: true });
    return;
  }
  await fs.mkdir(dirnamePath(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, prompt, 'utf8');
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch((): undefined => undefined);
    throw error;
  }
}

/** 「保存并应用」主题提示词：先落盘，再热更新调度器配置。 */
export async function persistTopicPrompt(
  wikiDir: string,
  dispatcher: DispatcherConfig,
  prompt: string,
): Promise<void> {
  const raw = typeof prompt === 'string' ? prompt : '';
  const next = raw.trim().length > 0 ? raw : '';
  await writeTopicPromptFile(wikiDir, next);
  dispatcher.customTopicPrompt = next;
}
