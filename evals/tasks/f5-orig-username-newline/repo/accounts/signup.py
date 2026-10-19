from accounts.validators import normalize_username


class Directory:
    def __init__(self):
        self.users = {}

    def signup(self, raw_username, email):
        name = normalize_username(raw_username)
        if name in self.users:
            raise ValueError("username taken")
        self.users[name] = email
        return name
