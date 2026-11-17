# Third-party notices

The code in this repository is licensed under the MIT licence, see [LICENSE](LICENSE). It depends on the packages below. `pip` installs them from `requirements.txt`; none of them is copied into this repository, so each keeps its own licence.

| Package | What it is used for | Licence |
|---|---|---|
| FastAPI | The web server and REST API | MIT |
| uvicorn | Runs the web server | BSD-3-Clause |
| SoCo | Controls Sonos speakers over UPnP | MIT |
| mutagen | Reads the tags, cover art and length inside music files | GPL-2.0-or-later |
| imageio-ffmpeg | Installs an ffmpeg program for audio conversion | BSD-2-Clause |
| yt-dlp | Downloads YouTube audio | Unlicense |
| yt-dlp-ejs | Solves YouTube's JavaScript checks; installed with `yt-dlp[default]` | Unlicense, MIT and ISC |

The licences come from each package's own metadata, read from the versions that `pip install -r requirements.txt` resolves. pip also installs the packages these depend on, for example pydantic. To list every licence in your environment, run `pip-licenses`.

## What to know

**mutagen is GPL-2.0-or-later.** It is a library that reads the information stored inside music files. The GPL is a copyleft licence, and the MIT licence is compatible with it, so this project can use mutagen. In practice:

- Running, forking or modifying this repository needs nothing special. You install mutagen yourself with `pip`.
- If you distribute a package that contains mutagen itself, for example an installer or a single `.exe` built with PyInstaller, you distribute that package under the GPL's terms and must make its source available.

This is a plain-language summary, not legal advice.

**The ffmpeg program may be a GPL build.** `imageio-ffmpeg` installs an ffmpeg executable. The Linux build checked while writing this file reports `--enable-gpl` and `--enable-version3`, so it is covered by GPL version 3. Builds for other systems may differ; `ffmpeg -version` shows how yours was built. This project starts ffmpeg as a separate program and does not link to it. If you redistribute the executable, follow ffmpeg's own terms, see <https://ffmpeg.org/legal.html>.

**Not distributed here.** Node.js, which yt-dlp uses for YouTube, is installed separately. The Outfit and JetBrains Mono fonts are loaded by the browser from Google Fonts and are not part of this repository.
