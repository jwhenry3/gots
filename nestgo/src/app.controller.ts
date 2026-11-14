// app.controller.ts — serves the view (@Render / GET /).

import nest from "nestgo/nest"

@Controller("/")
export class AppController {
    @Get("/")
    index(c: Ptr<nest.Ctx>): [Any, Error] {
        const data: map<string, Any> = new Map<string, Any>()
        data["Title"] = "NestGO"
        data["Message"] = "A NestJS-style app written in gots, compiled to Go"
        return [null, c.Render("index.html", data)]
    }
}
