// users.service.ts — the injectable service (@Injectable()).
// `interface User` becomes a Go struct; fields get json tags. The
// constructor seeds the in-memory store — it emits as NewUsersService(),
// which is exactly what the DI container calls by type.

import nest from "nestgo/nest"
import * as fmt from "fmt"
import * as sync from "sync"
import { CreateUserDto, UpdateUserDto } from "./dto/users.dto"

export interface User {
    id: Int
    name: string
    email: string
}

const emptyUser: User = { id: 0 as Int, name: "", email: "" }

@Injectable()
export class UsersService {
    users: User[]
    nextId: Int
    mu: sync.Mutex

    constructor() {
        const ada: User = { id: 1 as Int, name: "Ada Lovelace", email: "ada@example.com" }
        const alan: User = { id: 2 as Int, name: "Alan Turing", email: "alan@example.com" }
        this.users = [ada, alan]
        this.nextId = 3 as Int
    }

    findAll(): User[] {
        this.mu.Lock()
        try {
            return this.users
        } finally {
            this.mu.Unlock()
        }
    }

    findOne(id: Int): [User, Error] {
        this.mu.Lock()
        try {
            for (const u of this.users) {
                if (u.id === id) { return [u, null] }
            }
            return [emptyUser, nest.NotFoundException(`user ${id} not found`)]
        } finally {
            this.mu.Unlock()
        }
    }

    create(dto: Ptr<CreateUserDto>): User {
        this.mu.Lock()
        try {
            const u: User = { id: this.nextId, name: dto.name, email: dto.email }
            this.nextId = (this.nextId + 1) as Int
            this.users.push(u)
            return u
        } finally {
            this.mu.Unlock()
        }
    }

    update(id: Int, dto: Ptr<UpdateUserDto>): [User, Error] {
        this.mu.Lock()
        try {
            for (let i = 0; i < this.users.length; i++) {
                if (this.users[i].id === id) {
                    if (dto.name.length > 0) { this.users[i].name = dto.name }
                    if (dto.email.length > 0) { this.users[i].email = dto.email }
                    return [this.users[i], null]
                }
            }
            return [emptyUser, nest.NotFoundException(`user ${id} not found`)]
        } finally {
            this.mu.Unlock()
        }
    }

    remove(id: Int): Error {
        this.mu.Lock()
        try {
            const out: User[] = []
            for (const u of this.users) {
                if (u.id !== id) { out.push(u) }
            }
            this.users = out
        } finally {
            this.mu.Unlock()
        }
        return null
    }
}
