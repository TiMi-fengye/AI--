#!/usr/bin/env python3
"""Recover organization literals without running old JavaScript.

The default is a read-only count report. --apply creates a new file atomically,
never overwrites one, and uses hrsystem ownership when run as root. Non-root
callers keep their current ownership; --owner may explicitly name that account.
"""
import argparse
import getpass
import json
import os
import pathlib
import re
import stat
import sys
import tarfile
import tempfile


FIELDS = {
    "_companyOptions": "companies",
    "_personAttributes": "personAttributes",
    "_workAttributes": "workAttributes",
    "_workPositions": "positions",
    "_departments": "departments",
    "_buildingOptions": "buildings",
    "_regionOptions": "regions",
    "_roomOptions": "rooms",
}
REQUIRED = set(FIELDS) | {"_buildingLeaders"}
TARGET = "organization-settings.json"
MAX_SOURCE = 2 * 1024 * 1024


class RecoveryError(Exception):
    pass


class Literals:
    """A data-only parser for the opening properties of const Employees."""
    def __init__(self, text):
        self.text, self.position = text, 0

    def trivia(self):
        while self.position < len(self.text):
            if self.text[self.position].isspace() or self.text[self.position] == "\ufeff":
                self.position += 1
            elif self.text.startswith("//", self.position):
                end = self.text.find("\n", self.position + 2)
                self.position = len(self.text) if end < 0 else end + 1
            elif self.text.startswith("/*", self.position):
                end = self.text.find("*/", self.position + 2)
                if end < 0:
                    raise RecoveryError("Unterminated JavaScript comment")
                self.position = end + 2
            else:
                break

    def take(self, expected):
        self.trivia()
        if not self.text.startswith(expected, self.position):
            raise RecoveryError("Unsupported organization literal syntax")
        self.position += len(expected)

    def identifier(self):
        self.trivia()
        match = re.match(r"[A-Za-z_$][A-Za-z0-9_$]*", self.text[self.position:])
        if not match:
            raise RecoveryError("Expected a static property name")
        self.position += len(match[0])
        return match[0]

    def string(self):
        self.trivia()
        if self.position >= len(self.text) or self.text[self.position] not in "\"'":
            raise RecoveryError("Only quoted literal strings are permitted")
        quote = self.text[self.position]
        self.position += 1
        result = []
        escapes = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "v": "\v", "\\": "\\", "'": "'", '"': '"', "/": "/"}
        while self.position < len(self.text):
            character = self.text[self.position]
            self.position += 1
            if character == quote:
                try:
                    return "".join(result).encode("utf-16-le", "surrogatepass").decode("utf-16-le")
                except UnicodeError:
                    raise RecoveryError("Invalid Unicode in organization literals") from None
            if character in "\r\n":
                raise RecoveryError("Unescaped newline in organization literal")
            if character != "\\":
                result.append(character)
                continue
            if self.position >= len(self.text):
                break
            escape = self.text[self.position]
            self.position += 1
            if escape in escapes:
                result.append(escapes[escape])
            elif escape in ("u", "x"):
                count = 4 if escape == "u" else 2
                digits = self.text[self.position:self.position + count]
                if len(digits) != count or not re.fullmatch(r"[0-9a-fA-F]+", digits):
                    raise RecoveryError("Invalid Unicode escape in organization literal")
                result.append(chr(int(digits, 16)))
                self.position += count
            elif escape in "\r\n":
                if escape == "\r" and self.text[self.position:self.position + 1] == "\n":
                    self.position += 1
            else:
                raise RecoveryError("Unsupported escape in organization literal")
        raise RecoveryError("Unterminated organization literal")

    def value(self, depth=0):
        if depth > 8:
            raise RecoveryError("Organization literals are nested too deeply")
        self.trivia()
        if self.position >= len(self.text):
            raise RecoveryError("Incomplete organization literal")
        opening = self.text[self.position]
        if opening in "\"'":
            return self.string()
        if opening not in "[{":
            raise RecoveryError("Executable or non-literal organization value rejected")
        self.position += 1
        closing, result = ("]", []) if opening == "[" else ("}", {})
        self.trivia()
        while self.text[self.position:self.position + 1] != closing:
            if len(result) >= 1000:
                raise RecoveryError("Too many organization values")
            if opening == "[":
                result.append(self.value(depth + 1))
            else:
                self.trivia()
                key = self.string() if self.text[self.position:self.position + 1] in ("'", '"') else self.identifier()
                if key in result or key in ("__proto__", "prototype", "constructor"):
                    raise RecoveryError("Duplicate or unsafe organization property")
                self.take(":")
                result[key] = self.value(depth + 1)
            self.trivia()
            token = self.text[self.position:self.position + 1]
            if token == closing:
                break
            self.take(",")
            self.trivia()
        self.take(closing)
        return result

    def organization(self):
        if self.identifier() not in ("const", "let", "var") or self.identifier() != "Employees":
            raise RecoveryError("Expected a direct Employees object declaration")
        self.take("=")
        self.take("{")
        properties = {}
        while set(properties) != REQUIRED:
            self.trivia()
            key = self.string() if self.text[self.position:self.position + 1] in ("'", '"') else self.identifier()
            if key not in REQUIRED or key in properties:
                raise RecoveryError("Missing, duplicate or unexpected organization property")
            self.take(":")
            properties[key] = self.value()
            self.trivia()
            following = self.text[self.position:self.position + 1]
            if following not in (",", "}"):
                raise RecoveryError("Executable organization expression rejected")
            if following == "}":
                if set(properties) != REQUIRED:
                    raise RecoveryError("Missing organization properties")
            else:
                self.position += 1
        return properties


def clean_string(value, maximum=200, allow_empty=False):
    if not isinstance(value, str):
        raise RecoveryError("Organization values must be strings")
    value = value.strip()
    if (not value and not allow_empty) or len(value.encode("utf-16-le")) // 2 > maximum or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise RecoveryError("Empty, oversized or invalid organization string")
    return value


def strings(values):
    if not isinstance(values, list) or len(values) > 1000:
        raise RecoveryError("Organization options must be bounded arrays")
    result = []
    for value in values:
        value = clean_string(value, allow_empty=True)
        if value and value not in result:
            result.append(value)
    return result


def recover(archive):
    source = None
    with tarfile.open(archive, "r:*") as bundle:
        for count, member in enumerate(bundle, 1):
            if count > 50000:
                raise RecoveryError("Archive has too many members")
            if member.name not in ("js/employees.js", "./js/employees.js"):
                continue
            if source is not None:
                raise RecoveryError("Archive contains duplicate employees.js members")
            if not member.isfile() or member.issym() or member.islnk() or not 0 < member.size <= MAX_SOURCE:
                raise RecoveryError("Archive employees.js must be a bounded regular file")
            with bundle.extractfile(member) as stream:
                source = stream.read(MAX_SOURCE + 1)
    if source is None:
        raise RecoveryError("Archive does not contain js/employees.js")
    if len(source) > MAX_SOURCE:
        raise RecoveryError("Archive employees.js is too large")
    try:
        properties = Literals(source.decode("utf-8-sig")).organization()
    except UnicodeError:
        raise RecoveryError("Archive employees.js is not valid UTF-8") from None
    options = {target: strings(properties[original]) for original, target in FIELDS.items()}
    options["statuses"] = ["在职", "离职"]
    rows = properties["_buildingLeaders"]
    if not isinstance(rows, list) or len(rows) > 1000:
        raise RecoveryError("Building leaders must be a bounded array")
    leaders, seen = [], set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"building", "leaders"}:
            raise RecoveryError("Invalid building leader record")
        building = clean_string(row["building"])
        if building in seen:
            raise RecoveryError("Duplicate building leader record")
        seen.add(building)
        value = "、".join(strings(row["leaders"])) if isinstance(row["leaders"], list) else row["leaders"]
        leaders.append({"building": building, "leaders": clean_string(value, 2000, allow_empty=True)})
    return {"schemaVersion": 1, "revision": 0, "options": options, "buildingLeaders": leaders}


def ownership(owner):
    if os.name != "posix":
        if owner and owner.casefold() != getpass.getuser().casefold():
            raise RecoveryError("This platform can only retain current ownership")
        return None
    import pwd
    if owner:
        try:
            account = pwd.getpwuid(int(owner)) if owner.isdigit() else pwd.getpwnam(owner)
        except (KeyError, ValueError):
            raise RecoveryError("Requested owner does not exist") from None
        if os.geteuid() != 0 and account.pw_uid != os.geteuid():
            raise RecoveryError("Non-root callers can only retain current ownership")
        return account.pw_uid, account.pw_gid
    if os.geteuid() == 0:
        try:
            account = pwd.getpwnam("hrsystem")
        except KeyError:
            raise RecoveryError("Root recovery requires hrsystem; use --owner only for an explicit alternative") from None
        return account.pw_uid, account.pw_gid
    return os.geteuid(), os.getegid()


def apply(settings, directory, owner):
    destination = pathlib.Path(os.path.abspath(directory))
    if destination == pathlib.Path(destination.anchor):
        raise RecoveryError("Data directory must not be a filesystem root")
    for entry in [*reversed(destination.parents), destination]:
        try:
            info = entry.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise RecoveryError("Data directory and its parents must be real directories")
    identities = ownership(owner)
    created = not destination.exists()
    destination.mkdir(mode=0o700, exist_ok=True)
    if created and identities:
        os.chown(destination, *identities)
    target = destination / TARGET
    if target.exists() or target.is_symlink():
        raise RecoveryError("Organization settings already exist; nothing was overwritten")
    descriptor, temporary = tempfile.mkstemp(prefix=".organization-settings-", suffix=".tmp", dir=destination)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            if os.name == "posix":
                os.fchmod(stream.fileno(), 0o600)
                if identities:
                    os.fchown(stream.fileno(), *identities)
            stream.write(json.dumps(settings, ensure_ascii=False, indent=2) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        # link(2) creates the complete target atomically and fails if it exists.
        os.link(temporary, target, follow_symlinks=False)
        if os.name == "posix":
            directory_fd = os.open(destination, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        pathlib.Path(temporary).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, help="Server backup TAR containing js/employees.js")
    parser.add_argument("--data-dir", required=True, help="Actual application data directory")
    parser.add_argument("--apply", action="store_true", help="Create new organization settings; never overwrite")
    parser.add_argument("--owner", help="Root defaults to hrsystem; non-root defaults to current account")
    args = parser.parse_args()
    settings = recover(args.archive)
    if args.apply:
        apply(settings, args.data_dir, args.owner)
    counts = {key: len(values) for key, values in settings["options"].items()}
    counts["buildingLeaders"] = len(settings["buildingLeaders"])
    print(json.dumps({"applied": args.apply, "counts": counts}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (RecoveryError, OSError, tarfile.TarError) as error:
        # Deliberately omit archive contents, labels, names and password material.
        print("Organization recovery refused: " + (str(error) if isinstance(error, RecoveryError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
