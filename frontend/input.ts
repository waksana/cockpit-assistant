import { z } from 'zod';
import type { DraftOwnerFacts, DraftSendResult, ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';
import type { TimelineItem } from '../src/ui-types.ts';
import type { Submission } from './contracts.ts';
import { attachmentsSchema, inputSchema } from '../src/attachments.ts';

const identifier = z.string().min(1).max(200);
const payloadSchema = inputSchema.safeExtend({ attachments: attachmentsSchema });
const requestSchema = z.strictObject({
  version: z.literal(1), submissionId: identifier, actionRevision: z.int().nonnegative().safe(),
  payload: payloadSchema,
});
const receiptSchema = z.strictObject({
  version: z.literal(1), input: payloadSchema, messageId: identifier,
});
const projectedSchema = z.strictObject({ attachments: attachmentsSchema.optional() });
const submissionSchema = z.strictObject({
  requestId: identifier, submissionId: identifier,
  state: z.enum(['pending', 'accepted', 'unknown', 'error']), detail: z.string(),
  receipt: z.json().optional(),
});
type InputContext = Pick<ModuleFrontendContext, 'state' | 'request' | 'signal' | 'report'>;

export function createInput(context: InputContext, itemSchema: z.ZodType<TimelineItem>, changed: () => void) {
  const businessSchema = z.strictObject({
    version: z.literal(1), actionRevision: z.int().nonnegative().safe(),
    reply: itemSchema.nullable(), submissions: z.array(submissionSchema),
  });
  const empty = () => businessSchema.parse({ version: 1, actionRevision: 0, reply: null, submissions: [] });
  const schema = context.state.registerDraft({
    id: 'input-business', purposes: ['prompt'],
    create: empty, validate: value => businessSchema.parse(value),
    hasContent: () => false, project: () => undefined, acknowledge: current => current,
    persistence: {
      serialize: value => JSON.stringify(value),
      restore: ({ stored }) => {
        if (!stored.present) return empty();
        const saved = businessSchema.parse(JSON.parse(z.string().parse(stored.value)));
        return { ...saved, submissions: saved.submissions.map(entry => entry.state === 'pending'
          ? { ...entry, state: 'unknown' as const, detail: '页面已重新加载；请检查原提交回执，不会重发' } : entry) };
      },
    },
  });
  let availability = { open: false, ready: false, referenceText: undefined as string | undefined };
  let disposed = false;
  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await context.request(path, { ...init, signal: context.signal });
    const value: unknown = await response.json();
    if (!response.ok) {
      const error = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).safeParse(value);
      throw new Error(error.success ? `${error.data.error.code}: ${error.data.error.message}` : `HTTP ${response.status}`);
    }
    return value;
  };
  const inspect = async (saved: z.infer<typeof requestSchema>) => {
    try {
      const receipt = await request(`/inputs/${encodeURIComponent(saved.payload.requestId)}`);
      const proof = z.object({
        requestId: identifier, input: payloadSchema, message: z.object({ id: identifier }),
        deliveries: z.array(z.object({ state: z.string() })),
      }).parse(receipt);
      if (proof.requestId !== saved.payload.requestId || JSON.stringify(proof.input) !== JSON.stringify(saved.payload)) {
        throw new Error('原回执与完整输入快照不匹配');
      }
      setSubmission(saved.payload.requestId, {
        receipt: z.json().parse(receipt),
        detail: proof.deliveries.length
          ? `输入已保存；投递：${proof.deliveries.map(entry => entry.state).join('、')}（接受不代表完成）`
          : '输入已持久保存，等待编排和投递；尚不代表完成',
      });
      return { status: 'accepted' as const,
        receipt: receiptSchema.parse({ version: 1, input: proof.input, messageId: proof.message.id }) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setSubmission(saved.payload.requestId, { state: 'unknown', detail: `回执暂不可确认：${reason}；保留原请求，不会重发` });
      return { status: 'unknown' as const, reason };
    }
  };
  const owner = context.state.createDraft({
    key: 'conversation-input-v1', purpose: { kind: 'prompt' },
    facts: { editable: true, submittable: false, capabilities: { attachments: true }, actionRevision: 0 },
    validateRequest: value => requestSchema.parse(value),
    validateReceipt: value => receiptSchema.parse(value),
    prepare(snapshot) {
      const fields = projectedSchema.parse(snapshot.fields);
      const reply = scope.getSnapshot().reply;
      if (reply?.question) {
        if (fields.attachments?.length) throw new Error('原生提问不支持附件');
        if (reply.question.state !== 'pending') throw new Error('提问已失效，请取消回复引用');
        if (reply.question.allowFreeform === false && !reply.question.choices?.includes(snapshot.text)) {
          throw new Error('此问题仅接受列出的选项');
        }
      }
      return requestSchema.parse({
        version: 1, submissionId: snapshot.id, actionRevision: snapshot.base.actionRevision,
        payload: { requestId: crypto.randomUUID(), text: snapshot.text, attachments: fields.attachments ?? [],
          ...(reply?.anchorId ? { replyTo: reply.anchorId } : {}) },
      });
    },
    async send(saved) {
      scope.update(current => ({ ...current, submissions: [...current.submissions, {
        requestId: saved.payload.requestId, submissionId: saved.submissionId,
        state: 'pending', detail: '正在保存输入；接受不代表会话已处理',
      }] }));
      try {
        const response = await context.request('/messages', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(saved.payload), signal: context.signal,
        });
        if (!response.ok) {
          const error = z.object({ error: z.object({ code: z.string(), message: z.string() }) })
            .safeParse(await response.json());
          if (error.success && response.status < 500) {
            const reason = `${error.data.error.code}: ${error.data.error.message}`;
            setSubmission(saved.payload.requestId, { state: 'error', detail: reason });
            return { status: 'rejected', reason };
          }
          throw new Error(`HTTP ${response.status}：接收结果未知`);
        }
        return await inspect(saved);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        setSubmission(saved.payload.requestId, { state: 'unknown', detail: `${reason}；保留原请求，不会重发` });
        return { status: 'unknown', reason };
      }
    },
    inspect,
    settle(saved, receipt) {
      if (JSON.stringify(receipt.input) !== JSON.stringify(saved.payload)) throw new Error('保存的回执与原请求不匹配');
      scope.update(current => ({
        ...current,
        ...(current.actionRevision === saved.actionRevision
          ? { reply: null, actionRevision: current.actionRevision + 1 } : {}),
        submissions: current.submissions.map(entry => entry.requestId === saved.payload.requestId
          ? { ...entry, state: 'accepted' as const } : entry),
      }));
      sync();
    },
  });
  const scope = (() => {
    const scope = schema.forDraft(owner.reference);
    if (!scope) throw new Error('Assistant input business schema is unavailable');
    return scope;
  })();
  const setSubmission = (requestId: string, patch: Partial<Submission>) => {
    if (disposed) return;
    scope.update(current => ({ ...current, submissions: current.submissions.map(entry =>
      entry.requestId === requestId ? submissionSchema.parse({ ...entry, ...patch }) : entry) }));
  };
  const facts = (): DraftOwnerFacts => {
    const business = scope.getSnapshot();
    const question = business.reply?.question;
    const choiceOnly = question?.allowFreeform === false;
    return {
      editable: true,
      submittable: availability.open && availability.ready && (!question || question.state === 'pending')
        && (!choiceOnly || !!question?.choices?.includes(owner.reference.getSnapshot().text)),
      capabilities: { attachments: !question },
      actionRevision: Math.max(owner.reference.getSnapshot().actionRevision, business.actionRevision),
      ...(question ? { askContext: { question: business.reply!.text, choices: question.choices } } : {}),
      ...(availability.referenceText ? { referenceText: availability.referenceText } : {}),
    };
  };
  const sync = () => { if (!disposed) owner.update(facts()); };
  const offBusiness = scope.subscribe(() => { sync(); changed(); });
  const offDraft = owner.reference.subscribe(() => { sync(); changed(); });
  sync();
  const reflect = (result: DraftSendResult) => {
    if (result.status === 'blocked' || result.status === 'rejected') {
      throw new Error(`发送未完成：${result.reason}`);
    }
  };
  return {
    reference: owner.reference,
    business: scope.getSnapshot,
    update(open: boolean, ready: boolean, items: TimelineItem[]) {
      if (disposed || context.signal.aborted) return;
      const reply = items.find(item => item.id === scope.getSnapshot().reply?.id);
      if (reply && JSON.stringify(reply) !== JSON.stringify(scope.getSnapshot().reply)) {
        scope.update(current => ({ ...current, reply, actionRevision: current.actionRevision + 1 }));
      }
      const reference = [...items].reverse().find(item => item.speaker === 'assistant'
        && item.type === 'message' && !item.question)?.text;
      availability = { open, ready, referenceText: reference ? Array.from(reference).slice(-1000).join('') : undefined };
      sync();
    },
    edit: (text: string) => owner.editText(text),
    reply(item: TimelineItem | null) {
      scope.update(current => ({ ...current, reply: item,
        actionRevision: Math.max(current.actionRevision, owner.reference.getSnapshot().actionRevision) + 1 }));
    },
    close() {
      if (disposed || context.signal.aborted) return;
      scope.update(current => ({ ...current,
        actionRevision: Math.max(current.actionRevision, owner.reference.getSnapshot().actionRevision) + 1 }));
    },
    async send() { reflect(await owner.submit()); },
    async inspectInput(requestId: string) {
      const submission = scope.getSnapshot().submissions.find(entry => entry.requestId === requestId);
      const submissionId = submission?.submissionId ?? owner.reference.getSnapshot().submissionId;
      if (!submissionId) throw new Error('没有可恢复的原提交');
      if (submissionId === owner.reference.getSnapshot().submissionId) reflect(await owner.reconcile(submissionId));
      else {
        const receipt = await request(`/inputs/${encodeURIComponent(requestId)}`);
        const proof = z.object({ requestId: identifier, deliveries: z.array(z.object({ state: z.string() })) }).parse(receipt);
        if (proof.requestId !== requestId) throw new Error('回执编号不匹配');
        setSubmission(requestId, { receipt: z.json().parse(receipt),
          detail: `输入已保存；投递：${proof.deliveries.map(entry => entry.state).join('、') || '等待编排'}（接受不代表完成）` });
      }
    },
    dispose() { disposed = true; offBusiness(); offDraft(); },
  };
}
