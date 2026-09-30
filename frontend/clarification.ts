import { z } from 'zod';
import type { DraftOwner, DraftReference, ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';

const identifier = z.string().min(1).max(200);
const answer = z.string().max(100_000).refine(value => value.trim().length > 0, '请输入澄清内容');
export const clarificationSchema = z.object({
  id: identifier,
  question: z.string().min(1),
  choices: z.array(z.string()),
  allowFreeform: z.boolean(),
  createdAt: z.number().finite(),
  answer: z.string().nullable(),
  answeredAt: z.number().finite().nullable(),
  requestId: identifier.nullable(),
}).refine(value => value.answer === null
  ? value.answeredAt === null && value.requestId === null
  : value.answeredAt !== null && value.requestId !== null, '澄清答复记录不完整');
export type Clarification = z.infer<typeof clarificationSchema>;
const requestSchema = z.strictObject({
  version: z.literal(1), messageId: identifier, clarificationId: identifier,
  requestId: identifier, answer,
});
const receiptSchema = z.strictObject({
  version: z.literal(1), messageId: identifier, clarificationId: identifier,
  requestId: identifier, answer,
});
const responseSchema = z.object({ messageId: identifier, clarification: clarificationSchema });
type Request = z.infer<typeof requestSchema>;
type Context = Pick<ModuleFrontendContext, 'request' | 'signal' | 'state' | 'report'>;

export interface ClarificationActions {
  readonly draft: DraftReference;
  readonly error: string | null;
  readonly question: Clarification;
  edit(text: string): void;
  choose(text: string): Promise<void>;
  submit(): Promise<void>;
  update(value: Clarification): void;
  inspect(): Promise<void>;
}

export function createClarification(context: Context, messageId: string, initial: Clarification,
  changed: () => void): ClarificationActions {
  let current = initial;
  let error: string | null = null;
  let inspecting = false;
  let inspected: string | null = null;
  let completionCheckpoint = 0;
  let completionPending = false;
  const path = `/messages/${encodeURIComponent(messageId)}/clarifications/${encodeURIComponent(initial.id)}`;
  const reason = (value: unknown) => value instanceof Error ? value.message : String(value);
  const fail = (value: unknown) => { error = reason(value); changed(); };
  const facts = () => ({
    editable: current.answer === null && !completionPending,
    submittable: current.answer === null && !completionPending,
    capabilities: { attachments: false },
    actionRevision: Math.max(completionCheckpoint, current.answer === null ? 0 : 1),
    referenceText: [...current.question].slice(0, 1000).join(''),
  });
  const proof = (saved: Request, value: unknown) => {
    const response = responseSchema.parse(value);
    const result = response.clarification;
    if (response.messageId !== saved.messageId || result.id !== saved.clarificationId
      || result.requestId !== saved.requestId || result.answer !== saved.answer) {
      throw new Error('澄清答复尚未确认，保留原提交，不会重复发送');
    }
    current = result;
    return receiptSchema.parse({ version: 1, messageId: saved.messageId,
      clarificationId: saved.clarificationId, requestId: saved.requestId, answer: saved.answer });
  };
  const inspect = async (saved: Request) => {
    try {
      const response = await context.request(path, { signal: context.signal });
      if (!response.ok) throw new Error(`澄清答复查询失败：HTTP ${response.status}`);
      return { status: 'accepted' as const, receipt: proof(saved, await response.json()) };
    } catch (value) {
      fail(value);
      return { status: 'unknown' as const, reason: reason(value) };
    }
  };
  const owner: DraftOwner = context.state.createDraft({
    key: `clarification:${JSON.stringify([messageId, initial.id])}`,
    purpose: { kind: 'ask', requestId: initial.id },
    facts: facts(),
    validateRequest: value => requestSchema.parse(value),
    validateReceipt: value => receiptSchema.parse(value),
    prepare(snapshot) {
      if (completionPending || current.answer !== null) throw new Error('这条澄清已经提交，请先核对已保存的答复');
      const text = answer.parse(snapshot.base.text);
      if (!current.allowFreeform && !current.choices.includes(text)) throw new Error('请选择问题提供的选项');
      if (Object.keys(snapshot.fields).length) throw new Error('澄清答复不支持附件或额外字段');
      return requestSchema.parse({ version: 1, messageId, clarificationId: initial.id,
        requestId: crypto.randomUUID(), answer: text });
    },
    async send(saved) {
      try {
        const response = await context.request(path, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: saved.requestId, answer: saved.answer }),
          signal: context.signal,
        });
        const value: unknown = await response.json();
        if (!response.ok) {
          const known = z.object({ error: z.object({ message: z.string() }) }).safeParse(value);
          if (known.success && response.status < 500) {
            fail(known.data.error.message);
            return { status: 'rejected', reason: known.data.error.message };
          }
          throw new Error(`澄清答复状态无法确认：HTTP ${response.status}`);
        }
        return { status: 'accepted', receipt: proof(saved, value) };
      } catch (value) {
        fail(value);
        return { status: 'unknown', reason: reason(value) };
      }
    },
    inspect,
    settle(saved, receipt) {
      if (JSON.stringify(saved) !== JSON.stringify(receipt)) throw new Error('澄清答复回执与提交不匹配');
      error = null;
      changed();
    },
  });
  const syncOwner = () => {
    completionCheckpoint = Math.max(completionCheckpoint, owner.reference.getSnapshot().actionRevision);
    completionPending = completionCheckpoint > 0 && current.answer === null;
    owner.update(facts());
  };
  // The owner checkpoint survives reload even when the first timeline page is stale.
  syncOwner();
  const submit = async () => {
    try {
      error = null;
      changed();
      if (completionPending || current.answer !== null) {
        fail('这条澄清已经提交，请先核对已保存的答复');
        return;
      }
      const text = owner.reference.getSnapshot().text;
      if (!current.allowFreeform && !current.choices.includes(text)) {
        fail('请选择问题提供的选项');
        return;
      }
      const result = await owner.submit();
      if (result.status === 'rejected') fail(result.reason);
      else if (result.status === 'blocked') fail(`澄清答复暂不能提交：${result.reason}`);
      else if (result.status === 'unconfirmed' && !error) fail('澄清答复状态未确认，已保留原提交');
      syncOwner();
    } catch (value) { fail(value); }
  };
  return {
    draft: owner.reference,
    get error() { return error; },
    get question() { return current; },
    edit(text) {
      try { owner.editText(text); error = null; changed(); }
      catch (value) { fail(value); }
    },
    async choose(text) {
      const draft = owner.reference.getSnapshot();
      if (current.answer !== null || draft.pending || draft.unconfirmed) return;
      if (completionPending) { fail('这条澄清已经提交，请先核对已保存的答复'); return; }
      if (!current.choices.includes(text)) { fail('澄清选项已经变化'); return; }
      try { owner.editText(text); await submit(); }
      catch (value) { fail(value); }
    },
    submit,
    update(value) {
      if (value.id !== initial.id) throw new Error('澄清答复不能切换目标');
      // A delayed pending snapshot must not undo an acknowledged answer.
      if (current.answer !== null && value.answer === null) return;
      current = value;
      syncOwner();
    },
    async inspect() {
      const draft = owner.reference.getSnapshot();
      if (inspecting || draft.pending || (!draft.unconfirmed && !completionPending)) return;
      const checkpoint = JSON.stringify([draft.submissionId, current.requestId, completionPending]);
      if (inspected === checkpoint) return;
      inspected = checkpoint;
      inspecting = true;
      try {
        if (draft.unconfirmed && draft.submissionId) {
          await owner.reconcile(draft.submissionId);
        } else if (completionPending) {
          const response = await context.request(path, { signal: context.signal });
          if (!response.ok) throw new Error(`澄清答复查询失败：HTTP ${response.status}`);
          const result = responseSchema.parse(await response.json());
          if (result.messageId !== messageId || result.clarification.id !== initial.id
            || result.clarification.answer === null) {
            throw new Error('已提交的澄清与当前记录不一致，保留完成状态，不会重复发送');
          }
          current = result.clarification;
          error = null;
          changed();
        }
        syncOwner();
      }
      catch (value) { fail(value); }
      finally { inspecting = false; }
    },
  };
}
