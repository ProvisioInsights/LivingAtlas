export class FakeKVNamespace {
  private store = new Map<string, string>();
  lastPutOptions: { expirationTtl?: number } | undefined;
  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.lastPutOptions = options;
    this.store.set(key, value);
  }
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
