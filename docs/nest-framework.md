# nestgo/nest — framework reference

A NestJS-shaped framework in ~900 lines of Go (`nestgo/nest/`), consumed from
gots through decorators + ambient declarations.

## Decorator catalog (compile-time — no runtime reflection)

| Decorator | Placement | Emits |
|---|---|---|
| `@Module({imports, controllers, providers, exports})` | class | `func NewX() *nest.Module` — wiring inlined |
| `@Controller("/users")` | class | struct + `NewX` ctor; prefix stored for route wiring |
| `@Get / @Post / @Put / @Patch / @Delete / @Options / @Head / @All` | method | route entry `(verb, path, (*C).Method)` |
| `@Injectable()` | class | `func NewX()` emitted even without a constructor |
| `@UseGuards(G...)` | class / method | `.Guards(...)` / `nest.WithGuard(...)` route opts |
| `@UseInterceptors(I...)` | class / method | `.Interceptors(...)` / `nest.WithInterceptor(...)` |

Decorator args are class references: `providers: [UsersService]` ->
`NewUsersService`; `imports: [CoreModule]` -> `NewCoreModule()`;
`@UseGuards(AuthGuard)` -> `NewAuthGuard()` (or `&AuthGuard{}` if no ctor).

## DI model

- Providers are constructor functions `func(deps...) *T` resolved **by type**,
  exactly like NestJS constructor injection: `constructor(private users: UsersService)`
  emits `NewUserController(users *UsersService)` and the container fills it.
- `Module.Exports` controls cross-module visibility.
- `nest.Inject[T](app)` resolves a provider after bootstrap (`app.get(Token)`).

## Handler contract

```ts
@Get("/{id}")
findOne(c: Ptr<nest.Ctx>): [Any, Error] { ... }

@Post("/")
create(c: Ptr<nest.Ctx>, body: Ptr<CreateUserDto>): [Any, Error] { ... }
```

Registered as method expressions `(*Ctrl).Method`. The framework reflects the
signature: optional second param is decoded from the request body and, if it
implements `Validate() error`, validated (ValidationPipe equivalent).

## Ctx API (`*nest.Ctx`)

`Request()`, `ResponseWriter()`, `Param(name)`, `Query(name)`, `Header(name)`,
`SetHeader(k,v)`, `Body()`, `Status(code)`, `JSON(v)`, `Render(name, data)`,
`Set(key, v)`/`Get(key)` locals. `nest.Res(status, body)` returns an explicit
status wrapper.

## Application

`nest.Create(AppModule)` -> `(*Application, error)`:
`SetGlobalPrefix("/api")`, `SetViews("views/*.html")` (ancestor-walking glob
resolution), `Use(mw)`, `UseGuards`, `UseInterceptors`, `UseGlobalFilters(f)`,
`Handler()`, `Listen(addr)`, `Inject[T]`.

Route options per handler: `nest.WithGuard(...)`, `nest.WithInterceptor(...)`,
`nest.WithFilter(...)`.

## Exceptions + filters

`BadRequestException`, `UnauthorizedException`, `ForbiddenException`,
`NotFoundException`, `ConflictException`, `InternalServerErrorException`,
`NewHttpError(status, msg)` — produce `{"statusCode":N,"message":"..."}`.
`ExceptionFilter` interface + `UseGlobalFilters` handles uncaught errors.

## Guards / interceptors

```go
Guard:       CanActivate(c *Ctx) error
Interceptor: Intercept(c *Ctx, next HandlerFunc) (any, error)
```

## App layout convention (NestJS feature folders)

```
src/<feature>/<feature>.module.ts     @Module — declares the slice
src/<feature>/<feature>.controller.ts @Controller + routes
src/<feature>/<feature>.service.ts    @Injectable business logic
src/<feature>/<feature>.guards.ts     @Injectable guards/interceptors
src/<feature>/dto/*.ts                request DTOs with Validate()
src/core/                             shared providers (config, db)
src/main.ts                           bootstrap only
```

Each folder is a Go package — cross-folder imports emit `nestgo/src/<dir>`
imports automatically.
