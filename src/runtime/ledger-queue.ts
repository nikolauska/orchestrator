import { mutationOps, type HostOp } from "./helper-protocol";

const queues = new Map<string, Promise<void>>();
export function writesLedger(op: HostOp): boolean {
  return !!mutationOps[op] || ["worker.lookup", "operation.get", "delivery.lookup"].includes(op);
}

export function serializeLedger<T>(key: string, work: () => Promise<T>): Promise<T> {
  // Reconciliation also writes checkpoints; it must not race this controller's mutations.
  const result = (queues.get(key) ?? Promise.resolve()).then(work);
  const completed = result.then(
    () => {},
    () => {},
  );
  queues.set(key, completed);
  void completed.then(() => {
    if (queues.get(key) === completed) queues.delete(key);
  });
  return result;
}
