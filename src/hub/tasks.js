/**
 * tasks.js — Delegated work between agents, gated on human approval.
 *
 * An agent can ask another agent to do something, but the request does not
 * reach the assignee until a human approves it. That gate is the point: agents
 * handing each other work unsupervised is how a small misunderstanding becomes
 * a long, expensive chain of activity nobody asked for.
 *
 * Auto-approve exists for when that supervision is not wanted, and is
 * deliberately a persisted, visible setting rather than a per-call flag — the
 * human should never have to wonder whether approval is currently required.
 *
 * Used by: src/hub/bus.js
 */

/**
 * Lifecycle:
 *
 *   pending_approval ──approve──▶ approved ──▶ in_progress ──▶ done
 *          │                          │             │
 *          └──reject──▶ rejected      └─────────────┴──▶ cancelled
 */
const STATUS = {
  PENDING: 'pending_approval',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  IN_PROGRESS: 'in_progress',
  DONE: 'done',
  CANCELLED: 'cancelled',
};

// Transitions the assignee or assigner may make directly, once approved.
const AGENT_TRANSITIONS = {
  [STATUS.APPROVED]: [STATUS.IN_PROGRESS, STATUS.DONE, STATUS.CANCELLED],
  [STATUS.IN_PROGRESS]: [STATUS.DONE, STATUS.CANCELLED],
};

const OPEN_STATUSES = [STATUS.PENDING, STATUS.APPROVED, STATUS.IN_PROGRESS];

class TaskBoard {
  constructor(hub) {
    this.hub = hub;
    this.tasks = new Map(); // taskId -> task
    this.nextTaskNum = 1;
  }

  // ============================================
  // Persistence
  // ============================================

  serialize() {
    return {
      nextTaskNum: this.nextTaskNum,
      tasks: Array.from(this.tasks.values()),
    };
  }

  restore(state) {
    if (!state) return;
    this.nextTaskNum = state.nextTaskNum || 1;
    for (const task of state.tasks || []) this.tasks.set(task.id, task);
  }

  // ============================================
  // Creating
  // ============================================

  /**
   * Raise a task. Lands in pending_approval unless auto-approve is on, in
   * which case it is approved immediately and attributed to 'auto' so the
   * record still shows how it was cleared.
   */
  create({ fromAgentId, toAgentId, title, detail = '', channelId = null }) {
    const from = this.hub.getAgent(fromAgentId);
    const to = this.hub.getAgent(toAgentId);
    if (!to) throw new Error('the agent this task is for does not exist');

    // The master switch, or any group the assigner holds that grants it.
    const autoApproved = this.hub.canAutoApprove(fromAgentId);
    const task = {
      id: `tsk_${this.nextTaskNum++}`,
      title: String(title).slice(0, 200),
      detail: String(detail).slice(0, 4000),
      fromAgentId: fromAgentId || null,
      fromHandle: from?.handle || 'system',
      toAgentId,
      toHandle: to.handle,
      status: autoApproved ? STATUS.APPROVED : STATUS.PENDING,
      channelId,
      createdAt: Date.now(),
      decidedAt: autoApproved ? Date.now() : null,
      decidedBy: autoApproved ? 'auto' : null,
      completedAt: null,
    };

    this.tasks.set(task.id, task);
    this.hub.emit('task:changed', this.publicTask(task));

    if (autoApproved) this._announceApproval(task);
    else this._announce(task, `awaiting your approval`);

    this.hub.persist();
    return task;
  }

  // ============================================
  // Deciding
  // ============================================

  /** Approve or reject a pending task. The human does this from the console. */
  decide(taskId, { approved, byAgentId = null }) {
    const task = this._require(taskId);
    if (task.status !== STATUS.PENDING) {
      throw new Error(`task ${taskId} is ${task.status}, not awaiting approval`);
    }

    task.status = approved ? STATUS.APPROVED : STATUS.REJECTED;
    task.decidedAt = Date.now();
    task.decidedBy = byAgentId;

    this.hub.emit('task:changed', this.publicTask(task));
    if (approved) this._announceApproval(task);
    else this._announce(task, 'was declined');

    this.hub.persist();
    return task;
  }

  /**
   * Move an approved task along. Restricted to the two agents involved —
   * a third agent marking someone else's work done is not a thing.
   */
  setStatus(taskId, status, byAgentId) {
    const task = this._require(taskId);

    if (byAgentId && byAgentId !== task.toAgentId && byAgentId !== task.fromAgentId) {
      throw new Error('only the agent a task is for, or the one who raised it, can change it');
    }

    const allowed = AGENT_TRANSITIONS[task.status] || [];
    if (!allowed.includes(status)) {
      throw new Error(
        `a task that is ${task.status} cannot become ${status}` +
          (task.status === STATUS.PENDING ? ' — it still needs approval' : '')
      );
    }

    task.status = status;
    if (status === STATUS.DONE) task.completedAt = Date.now();

    this.hub.emit('task:changed', this.publicTask(task));
    this._announce(task, status === STATUS.DONE ? 'is done' : `is now ${status.replace('_', ' ')}`);
    this.hub.persist();
    return task;
  }

  // ============================================
  // Reading
  // ============================================

  get(taskId) {
    return this.tasks.get(taskId) || null;
  }

  /** Filter by assignee, assigner, or status. `open` covers everything live. */
  list({ assigneeId = null, assignerId = null, status = null, openOnly = false } = {}) {
    return Array.from(this.tasks.values())
      .filter((task) => {
        if (assigneeId && task.toAgentId !== assigneeId) return false;
        if (assignerId && task.fromAgentId !== assignerId) return false;
        if (status && task.status !== status) return false;
        if (openOnly && !OPEN_STATUSES.includes(task.status)) return false;
        return true;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  pendingCount() {
    return this.list({ status: STATUS.PENDING }).length;
  }

  publicTask(task) {
    return { ...task };
  }

  // ============================================
  // Internals
  // ============================================

  _require(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`no task with id ${taskId}`);
    return task;
  }

  /**
   * Narrate a task change into the channel it was raised in, so it shows up in
   * the transcript and wakes the relevant agent's long-poll. System messages
   * do not drive browser peers, which keeps a task from silently spending a
   * claude.ai turn.
   */
  _announce(task, phrase) {
    const channelId = task.channelId || this.hub.getChannel(this.hub.defaultChannelName)?.id;
    if (!channelId) return;

    this.hub.postSystemMessage(
      channelId,
      `Task ${task.id} — "${task.title}" — from @${task.fromHandle} for @${task.toHandle} ${phrase}.`,
      { taskId: task.id, taskStatus: task.status }
    );
  }

  _announceApproval(task) {
    this._announce(task, `is approved and waiting on @${task.toHandle}`);
  }
}

module.exports = { TaskBoard, TASK_STATUS: STATUS, OPEN_STATUSES };
