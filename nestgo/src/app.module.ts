// app.module.ts — the root @Module. `imports` takes module classes, which
// emit as their generated NewX() module factories.

import { CoreModule } from "./core/core.module"
import { UsersModule } from "./users/users.module"
import { AppController } from "./app.controller"

@Module({ imports: [CoreModule, UsersModule], controllers: [AppController] })
export class AppModule {}
