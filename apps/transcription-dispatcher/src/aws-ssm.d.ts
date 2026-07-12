declare module "@aws-sdk/client-ssm" {
  export class SSMClient {
    constructor(options: Record<string, unknown>);
    send(command: GetParametersCommand): Promise<{
      Parameters?: Array<{ Name?: string; Value?: string }>;
      InvalidParameters?: string[];
    }>;
  }
  export class GetParametersCommand {
    constructor(input: { Names: string[]; WithDecryption: true });
  }
}
