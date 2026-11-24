import { IsEmail, IsString, MinLength, MaxLength } from "class-validator";
import { Transform } from "class-transformer";

export class LoginDto {
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim() : value,
  )
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}
