# Manual checks before a release

The automated tests (`pnpm check`) cover the code paths. These checks cover what they cannot:
the built image and the plugin on a real machine. Run them against a freshly built container.

The container from `docker-compose.yml` runs open (no proxy identity), so `/me/devices` and `/reminders`
show nothing there: a signed-in person is a proxy viewer. Run steps 4, 6 and 9 behind a sign-in proxy, or with
`BAB_TRUST_PROXY_IDENTITY=1` and a client that sends the `x-auth-request-*` headers.

1. **Build and boot.** `docker build` the image and start it with an empty `/data` volume.
   `GET /healthz` and `GET /readyz` answer 200. Stopping the container (SIGTERM) exits within a few seconds.
2. **Pages load.** `/`, `/docs`, `/changelog`, `/memory`, `/inbox`, `/reminders`, `/board` and `/usage` render
   without errors. The top changelog entry is the one you are releasing.
3. **Plugin install.** On a clean machine, follow `/instructions/install.md`: add the marketplace, install the
   plugin, set `bab_url`. Then `bab_send` yourself a message. The next prompt shows "BAB: 1 unread message",
   and, on Claude Code 2.1.287 or newer with mods enabled, the teal pill above the prompt.
4. **Identify and remember.** `bab_identify` works for a new person. `/me/devices` lists the device with its
   address, and **Forget** removes it, so the device is unknown again until Claude identifies it. `/connect/<anything>`
   only shows "This link is no longer needed".
5. **Memory round trip.** `bab_learn` a memory, find it with `bab_search`, then react to it. It appears on `/memory`.
6. **Messages and reminders.** `bab_send` between two identities lands in the other inbox, and the thread opens
   on `/conversations/<id>` for both of them and for a maintainer, and answers 404 for anyone else.
   `bab_remind` shows up under `/reminders` (read-only there). Complete it with `bab_remind`, and it shows as Completed.
7. **Restart keeps data.** Restart the container. The memory, messages and reminders from above are still there.
8. **Configuration.** Starting with a bad setting (for example an empty token file) stops the app with a clear
   message instead of running open. `BAB_TRUST_PROXY_IDENTITY=1` with no `BAB_PROXY_SECRET` stops it too, unless
   `BAB_TRUST_PROXY_WITHOUT_SECRET=1`.
9. **Upgrade keeps data.** Copy the `/data` volume of the previous release. Start the new image on the copy with
   the settings of that deployment (`BAB_TRUST_PROXY_IDENTITY=1`, `BAB_TRUST_PROXY_WITHOUT_SECRET=1` if it has no
   secret, and `BAB_EXTRA_APPLIES_TO` for any platform label its memories carry that the new release no longer lists).
   Memories, messages and reminders are all there, a signed-in person still sees their own inbox and reminders,
   a device that identified before still resolves, and `/admin/links` still shows the sign-in email and name of
   existing browser links. Never run the new image on the only copy of a production volume.
