// main.ts — NestFactory.create(AppModule) + app.listen().
// `AppModule` (the @Module class) emits `NewAppModule()` — the generated
// module factory — so this reads exactly like NestFactory.create(AppModule).

import nest from "nestgo/nest"
import { AppModule } from "./app.module"
import { ConfigService } from "./core/config.service"

function main() {
    const [app, err] = nest.Create(AppModule)
    if (err !== null) {
        throw err
    }
    app.SetGlobalPrefix("/api")
    const verr = app.SetViews("views/*.html")
    if (verr !== null) {
        throw verr
    }
    // app.get(ConfigService) — resolve a provider after bootstrap
    const [cfg, cerr] = nest.Inject<ConfigService>(app)
    const addr: string = cerr === null ? cfg.port() : ":3000"
    const lerr = app.Listen(addr)
    if (lerr !== null) {
        throw lerr
    }
}
