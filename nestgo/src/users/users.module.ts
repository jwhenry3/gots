// users.module.ts — @Module({ controllers, providers, exports }).
// Route registration comes from the @Controller/@Get/... metadata on
// UserController — the module file itself stays declarative, like NestJS.

import { UserController } from "./users.controller"
import { UsersService } from "./users.service"

@Module({ controllers: [UserController], providers: [UsersService], exports: [UsersService] })
export class UsersModule {}
