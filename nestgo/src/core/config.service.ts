// config.service.ts — @Injectable() provider.
// The transpiler reads decorators and emits the provider constructor
// (NewConfigService) + module wiring automatically — no factory boilerplate.

import * as os from "os"

@Injectable()
export class ConfigService {
    port(): string {
        const p = os.Getenv("PORT")
        return p.length > 0 ? ":" + p : ":3000"
    }
    apiKey(): string {
        return "secret"
    }
}
