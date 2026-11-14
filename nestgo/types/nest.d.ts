// Declarations for the nestgo/nest framework package.
// Handlers are registered as method expressions: `Ctrl.prototype.handler`
// emits `(*Ctrl).Handler` — the `any` params below keep the boundary loose
// like the Go `any`-typed registration API does.

declare module "nestgo/nest" {

    // ---- module graph --------------------------------------------------------
    export class Module {
        Imports(...mods: Module[]): Module
        Controllers(...ctrls: any[]): Module
        Providers(...providers: any[]): Module
        Exports(...providers: any[]): Module
    }
    export function NewModule(name: string): Module

    // ---- controller builder ---------------------------------------------------
    export class ControllerBuilder {
        Guards(...gs: any[]): ControllerBuilder
        Interceptors(...is: any[]): ControllerBuilder
        Get(path: string, h: any, ...opts: any[]): ControllerBuilder
        Post(path: string, h: any, ...opts: any[]): ControllerBuilder
        Put(path: string, h: any, ...opts: any[]): ControllerBuilder
        Patch(path: string, h: any, ...opts: any[]): ControllerBuilder
        Delete(path: string, h: any, ...opts: any[]): ControllerBuilder
    }
    export function Controller(prefix: string, ctor: any): ControllerBuilder

    // ---- request context -------------------------------------------------------
    export class Ctx {
        Request(): any
        ResponseWriter(): any
        Param(name: string): string
        Query(name: string): string
        Header(name: string): string
        SetHeader(name: string, value: string): void
        Body(v: any): Error
        Status(code: number): Ctx
        JSON(status: number, v: any): void
        Render(name: string, data: any): Error
    }
    export function Res(status: number, body: any): any

    // ---- errors / filters -------------------------------------------------------
    export class HttpError extends Error {
        Message: string
        Status: int
    }
    export function NewHttpError(status: number, msg: string): HttpError
    export function BadRequestException(msg: string): HttpError
    export function UnauthorizedException(msg: string): HttpError
    export function ForbiddenException(msg: string): HttpError
    export function NotFoundException(msg: string): HttpError
    export function ConflictException(msg: string): HttpError
    export function InternalServerErrorException(msg: string): HttpError

    // ---- guards / interceptors ----------------------------------------------------
    export type HandlerFunc = (c: Ptr<Ctx>) => [Any, Error]
    export function WithGuard(...gs: any[]): any
    export function WithInterceptor(...is: any[]): any

    // ---- application ---------------------------------------------------------------
    export class Application {
        Use(...mws: any[]): Application
        UseGuards(...gs: any[]): Application
        UseInterceptors(...is: any[]): Application
        UseGlobalFilters(f: any): Application
        SetGlobalPrefix(prefix: string): Application
        SetViews(pattern: string): Error
        Handler(): any
        Listen(addr: string): Error
    }
    export function Create(root: any): [Application, Error]
    /** app.get(Token) — resolve a provider instance by type after bootstrap */
    export function Inject<T>(a: Application): [Ptr<T>, Error]
}

// ---- decorators — compile-time metadata, erased at emit -----------------------
// These are ambient globals (no import needed): the transpiler reads them and
// emits the equivalent nest.NewModule/Controller/route wiring into the package.

interface ModuleMeta {
    imports?: any[]
    controllers?: any[]
    providers?: any[]
    exports?: any[]
}
declare function Module(meta: ModuleMeta): any
declare function Controller(prefix?: string): any
declare function Injectable(): any
declare function Get(path?: string): any
declare function Post(path?: string): any
declare function Put(path?: string): any
declare function Patch(path?: string): any
declare function Delete(path?: string): any
declare function Options(path?: string): any
declare function Head(path?: string): any
declare function All(path?: string): any
declare function UseGuards(...guards: any[]): any
declare function UseInterceptors(...interceptors: any[]): any
