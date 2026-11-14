// users/dto — request bodies with Validate(), the class-validator +
// ValidationPipe analogue. Class fields become exported struct fields with
// json tags preserving the TS key names.

import * as nest from "nestgo/nest"

export class CreateUserDto {
    name: string
    email: string

    Validate(): Error {
        if (this.name.length < 2 || !this.email.includes("@")) {
            return nest.BadRequestException("valid name and email are required")
        }
        return null
    }
}

export class UpdateUserDto {
    name: string
    email: string
}
