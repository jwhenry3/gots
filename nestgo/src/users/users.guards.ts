// users.guards.ts — @UseGuards / @UseInterceptors targets.
// @Injectable() marks them for DI construction; the framework interfaces
// (CanActivate / Intercept) are already Go-cased method names.

import nest from "nestgo/nest"
import * as log from "log"
import * as time from "time"

@Injectable()
export class AuthGuard {
    CanActivate(c: Ptr<nest.Ctx>): Error {
        if (c.Header("x-api-key") !== "secret") {
            return nest.UnauthorizedException("missing or invalid x-api-key")
        }
        return null
    }
}

@Injectable()
export class LoggingInterceptor {
    Intercept(c: Ptr<nest.Ctx>, next: nest.HandlerFunc): [Any, Error] {
        const start = time.Now()
        const [res, err] = next(c)
        log.Printf("[users] %s %s took %v", c.Request().Method, c.Request().URL.Path, time.Since(start))
        return [res, err]
    }
}
