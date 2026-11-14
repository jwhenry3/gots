// core.module.ts — a global-style module exporting ConfigService.
// @Module({...}) emits `func NewCoreModule() *nest.Module` with the
// provider/export wiring inlined — exactly like NestJS module metadata.

import { ConfigService } from "./config.service"

@Module({ providers: [ConfigService], exports: [ConfigService] })
export class CoreModule {}
