// users.controller.ts — @Controller("users") with decorator routes.
// The constructor emits NewUserController(users *UsersService) — DI
// resolves the dependency by type, same as NestJS constructor injection.
// Handler shape: (c: Ptr<nest.Ctx>[, body: Ptr<Dto>]): [Any, Error].

import nest from "nestgo/nest"
import * as strconv from "strconv"
import { UsersService } from "./users.service"
import { CreateUserDto, UpdateUserDto } from "./dto/users.dto"
import { AuthGuard, LoggingInterceptor } from "./users.guards"

@Controller("/users")
@UseInterceptors(LoggingInterceptor)
export class UserController {
    constructor(private users: UsersService) {}

    @Get("/")
    findAll(c: Ptr<nest.Ctx>): [Any, Error] {
        return [this.users.findAll(), null]
    }

    @Get("/{id}")
    findOne(c: Ptr<nest.Ctx>): [Any, Error] {
        const [id, err] = strconv.Atoi(c.Param("id"))
        if (err !== null) {
            return [null, nest.BadRequestException("id must be a number")]
        }
        return this.users.findOne(id)
    }

    @Post("/")
    create(c: Ptr<nest.Ctx>, body: Ptr<CreateUserDto>): [Any, Error] {
        return [nest.Res(201, this.users.create(body)), null]
    }

    @Patch("/{id}")
    update(c: Ptr<nest.Ctx>, body: Ptr<UpdateUserDto>): [Any, Error] {
        const [id, err] = strconv.Atoi(c.Param("id"))
        if (err !== null) {
            return [null, nest.BadRequestException("id must be a number")]
        }
        return this.users.update(id, body)
    }

    @Delete("/{id}")
    @UseGuards(AuthGuard)
    remove(c: Ptr<nest.Ctx>): [Any, Error] {
        const [id, err] = strconv.Atoi(c.Param("id"))
        if (err !== null) {
            return [null, nest.BadRequestException("id must be a number")]
        }
        return [null, this.users.remove(id)]
    }
}
