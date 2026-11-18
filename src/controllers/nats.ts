import { connect } from "@nats-io/transport-node";

export class NatsController {
  constructor(
    private readonly servers: string,
    private readonly token?: string,
  ) {}

  async check(): Promise<void> {
    const connection = await connect({
      servers: this.servers,
      token: this.token,
      timeout: 5000,
      reconnect: false,
      name: "steele-connectivity",
    });
    try {
      await connection.flush();
    } finally {
      await connection.close();
    }
  }
}
