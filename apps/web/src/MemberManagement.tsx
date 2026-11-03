/** 群成员档案管理。分页来自服务端，修改与删除按稳定成员 ID 定位；同名和跨群成员不可推断合并。 */
import { useEffect, useState } from 'react';
import {
  FloppyDisk,
  Trash,
  ArrowCounterClockwise,
  ClockCounterClockwise,
} from '@phosphor-icons/react';
import { api, dateTime, parseTags, useAction } from './api';
import { Badge, Button, Confirm, Feedback, Field, Modal, Notice, Toggle } from './ui';
import type { GroupMember } from './GroupFeatures';
import type { ReactNode } from 'react';

export function MemberCreator({
  chatId,
  onClose,
  onSaved,
  onDirty,
}: {
  chatId: string;
  onClose: () => void;
  onSaved: (member: GroupMember) => Promise<void>;
  onDirty: (value: boolean) => void;
}) {
  const [nickname, setNickname] = useState(''),
    action = useAction();
  return (
    <Modal title="添加群成员" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            const member = await api<GroupMember>(`/api/chats/${chatId}/members`, 'POST', {
              nickname: nickname.trim(),
            });
            await onSaved(member);
          });
        }}
      >
        <Field label="成员昵称">
          <input
            autoFocus
            required
            maxLength={200}
            value={nickname}
            onChange={(event) => {
              setNickname(event.target.value);
              onDirty(true);
            }}
          />
        </Field>
        <Notice>
          添加后为普通、未确认成员。聊天中的真实身份依据仍由桥接识别，画像由 Agent 自动整理。
        </Notice>
        <Feedback error={action.error} />
        <div className="button-row">
          <Button type="submit" variant="primary" busy={action.busy}>
            添加成员
          </Button>
          <Button type="button" onClick={onClose}>
            取消
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ManagedMemberEditor({
  member,
  chatId,
  onDirty,
  onSaved,
  onDeleted,
  onHistory,
  review,
  evidence,
}: {
  member: GroupMember;
  chatId: string;
  onDirty: (value: boolean) => void;
  onSaved: (member: GroupMember) => Promise<void>;
  onDeleted: () => Promise<void>;
  onHistory: () => void;
  review: ReactNode;
  evidence: ReactNode;
}) {
  const [nickname, setNickname] = useState(member.nickname),
    [aliases, setAliases] = useState(member.aliases.join('，')),
    [pinned, setPinned] = useState(member.pinned),
    [dirty, setDirty] = useState(false),
    [remove, setRemove] = useState(false),
    [reset, setReset] = useState(false),
    [taskId, setTaskId] = useState<string>(),
    action = useAction();
  const mark = () => {
    setDirty(true);
    onDirty(true);
  };
  useEffect(() => {
    if (!dirty) {
      setNickname(member.nickname);
      setAliases(member.aliases.join('，'));
      setPinned(member.pinned);
    }
  }, [member, dirty]);
  useEffect(() => {
    if (!taskId) return;
    let disposed = false;
    const check = async () => {
      try {
        const task = await api<{ state: string; error?: string; result?: { status?: string } }>(
          `/api/tasks/${taskId}`,
        );
        if (disposed || !['completed', 'cancelled', 'failed'].includes(task.state)) return;
        setTaskId(undefined);
        if (task.state === 'failed')
          await action.run(async () => {
            throw new Error(task.error || 'Agent 整理失败，请在运行记录重试。');
          });
        else {
          await onSaved(await api<GroupMember>(`/api/chats/${chatId}/members/${member.id}`));
          await action.run(async () => {
            if (task.state === 'cancelled' || task.result?.status === 'cancelled')
              throw new Error('整理期间记忆或成员发生变化，本次结果已取消，可重新整理。');
          }, 'Agent 已完成记忆整合。');
        }
      } catch {
        /* A transient read failure is retried while the task is pending. */
      }
    };
    void check();
    const timer = setInterval(() => void check(), 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [taskId, chatId, member.id]);
  return (
    <>
      <div className="member-identity">
        <div>
          <h2>{member.nickname || '未命名成员'}</h2>
          <p>群内序号 #{String(member.number).padStart(3, '0')}</p>
          <p className="member-id">ID: {member.id}</p>
        </div>
      </div>
      {review}
      <section className="member-auto-profile">
        <div className="section-title">
          <h3>Agent 综合印象</h3>
          <Button
            type="button"
            disabled={dirty || Boolean(taskId)}
            busy={action.busy}
            onClick={() =>
              action.run(async () => {
                const result = await api<{ queued: boolean; taskId?: string; message: string }>(
                  `/api/chats/${chatId}/members/${member.id}/compact`,
                  'POST',
                  {},
                );
                if (result.queued) setTaskId(result.taskId);
                else throw new Error(result.message);
              }, '已排队，Agent 正在整理记忆。')
            }
          >
            {taskId ? 'Agent 整理中…' : '让 Agent 整理'}
          </Button>
        </div>
        <p className="hint">自动合并同一成员的兴趣、偏好与经历；积累新记忆后自动更新，无需手填。</p>
        {member.pinned && <p className="hint">当前展示已固定的画像快照。</p>}
        <p className="member-impression-text">
          {member.profile?.summary || '尚未积累足够的有效记忆。识别后的聊天会自动形成印象。'}
        </p>
        {!member.pinned && member.impression && member.impression.tags.length > 0 && (
          <p className="alias-line">
            {member.impression.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </p>
        )}
        {!member.pinned && member.impression?.updatedAt && (
          <p className="hint">最近整理：{dateTime(member.impression.updatedAt)}</p>
        )}
        {dirty && <p className="hint">请先保存称呼，再触发整理。</p>}
      </section>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            const saved = await api<GroupMember>(
              `/api/chats/${chatId}/members/${member.id}`,
              'PATCH',
              { nickname: nickname.trim(), aliases: parseTags(aliases), pinned },
            );
            setDirty(false);
            onDirty(false);
            await onSaved(saved);
          }, '成员称呼已保存。');
        }}
      >
        <h3>称呼管理</h3>
        <Field label="成员昵称">
          <input
            required
            maxLength={200}
            value={nickname}
            onChange={(event) => {
              setNickname(event.target.value);
              mark();
            }}
          />
        </Field>
        <Field label="旧称呼与别名" hint="用逗号分隔。移除某个称呼后保存，即可删除该别名。">
          <input
            value={aliases}
            onChange={(event) => {
              setAliases(event.target.value);
              mark();
            }}
          />
        </Field>
        <Toggle
          label="固定当前画像"
          checked={pinned}
          onChange={(value) => {
            setPinned(value);
            mark();
          }}
        />
        <p className="hint">固定后保留当前画像；解除固定会使用最新的 Agent 印象。</p>
        <div className="detail-actions">
          <Button type="submit" variant="primary" busy={action.busy}>
            <FloppyDisk size={18} />
            保存称呼
          </Button>
          <Button type="button" onClick={onHistory}>
            <ClockCounterClockwise size={18} />
            查看版本
          </Button>
          <span className="hint">
            版本 {member.version}
            {dirty ? ' · 有未保存修改' : ''}
          </span>
        </div>
      </form>
      {evidence}
      <div className="mode-status">
        <strong>当前模式</strong>
        <Badge>{member.mode === 'normal' ? '普通人格' : member.mode}</Badge>
        <Button disabled={member.mode === 'normal'} onClick={() => setReset(true)}>
          <ArrowCounterClockwise size={18} />
          重置模式
        </Button>
      </div>
      <Feedback error={action.error} success={action.success} />
      <div className="detail-actions">
        <Button variant="danger" onClick={() => setRemove(true)}>
          <Trash size={18} />
          删除成员档案
        </Button>
      </div>
      {reset && (
        <Confirm
          title="重置此成员模式"
          confirm="重置为普通人格"
          onClose={() => setReset(false)}
          onConfirm={async () => {
            await onSaved(
              await api<GroupMember>(
                `/api/chats/${chatId}/members/${member.id}/reset-mode`,
                'POST',
                {},
              ),
            );
          }}
        >
          仅重置当前群的此成员模式。
        </Confirm>
      )}
      {remove && (
        <Confirm
          title="删除成员档案及记忆"
          danger
          confirm="删除成员及全部记忆"
          onClose={() => setRemove(false)}
          onConfirm={async () => {
            await api(`/api/chats/${chatId}/members/${member.id}`, 'DELETE');
            onDirty(false);
            await onDeleted();
          }}
        >
          将删除「{member.nickname}
          」的档案、旧称呼、全部关联记忆（含固定记忆）、画像历史和本群权限。群聊天记录保留，后续新消息可重新识别并建立新档案。此操作无法撤销。
        </Confirm>
      )}
    </>
  );
}
