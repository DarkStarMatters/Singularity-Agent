/**
 * Reading lean-worker's task files, and checking what they claim.
 *
 * Each agent file states a room id and, per task, an encryption key. Both are
 * supposed to follow from the shared salt by the rules in `template.json`, so
 * each is recomputed here and compared rather than trusted: a task file whose
 * key does not derive is one whose envelopes nobody else can open.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { roomId, sealedWithPublicSalt, taskKey } from './relay.js';

export interface TaskSummary {
  file: string;
  agent: string;
  description?: string;
  /** Present on agent files that carry relay settings. */
  relay?: {
    room: string;
    roomDerives: boolean;
    /** True when the salt is the one committed to the public repository. */
    publicSalt: boolean;
  };
  tasks: Array<{ id: string; wave?: string; title?: string; keyDerives?: boolean }>;
}

interface RawTask {
  id?: string;
  task_id?: string;
  wave?: string;
  title?: string;
  enc_key?: string;
}

export function readTasks(checkout: string): TaskSummary[] {
  const dir = join(checkout, 'minimal', 'tasks');
  if (!existsSync(dir)) throw new Error(`no task directory at ${dir}`);

  const out: TaskSummary[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const agent = typeof raw.agent_id === 'string' ? raw.agent_id : null;
    if (!agent) continue; // template.json and similar

    const salt = typeof raw.shared_salt === 'string' ? raw.shared_salt : null;
    const summary: TaskSummary = {
      file,
      agent,
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      tasks: [],
    };
    if (salt && typeof raw.room_id === 'string') {
      summary.relay = { room: raw.room_id, roomDerives: roomId(salt, agent) === raw.room_id, publicSalt: sealedWithPublicSalt(salt) };
    }
    for (const t of (Array.isArray(raw.tasks) ? raw.tasks : []) as RawTask[]) {
      const id = t.id ?? t.task_id;
      if (!id) continue;
      summary.tasks.push({
        id,
        ...(t.wave ? { wave: t.wave } : {}),
        ...(t.title ? { title: t.title } : {}),
        ...(salt && t.enc_key ? { keyDerives: taskKey(id, salt).toString('hex') === t.enc_key } : {}),
      });
    }
    out.push(summary);
  }
  return out;
}
