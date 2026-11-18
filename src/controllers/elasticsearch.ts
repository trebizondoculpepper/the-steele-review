import { Client } from "@elastic/elasticsearch";

export class ElasticsearchController {
  private readonly client: Client;

  constructor(node: string, apiKey?: string) {
    this.client = new Client({
      node,
      requestTimeout: 5000,
      maxRetries: 0,
      ...(apiKey ? { auth: { apiKey } } : {}),
    });
  }

  async check(): Promise<void> {
    await this.client.info();
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
