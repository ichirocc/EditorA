# EditorA (native)

A small, fully native Android code editor written in Kotlin. It lives next to
the Cordova-based Acode build in this repository and does not share code with it.

## Why native

- **Japanese and other IME input** goes through Android's own text field, so
  kana-kanji conversion works as in any other app. Syntax colouring is never
  applied while the IME is composing.
- **No permissions and no network access.** Files are opened and saved through
  the system file picker (Storage Access Framework). The CI build fails if the
  APK requests any permission.
- **No third-party libraries.** The app uses only the Android framework and the
  Kotlin standard library.

## Features

Tabs, open/save/save as through the file picker, line numbers, syntax colouring
(JavaScript/TypeScript, JSON, CSS, Python, Kotlin/Java, C-family, shell/config,
SQL, HTML/XML, Markdown), undo/redo that treats one IME conversion as one step,
find and replace (case, whole word, regex), auto-indent, a row of code keys
above the keyboard, hardware-keyboard shortcuts (Ctrl+S/Z/Y/F/O/N/W), and
restore of open tabs, including unsaved text, after the app is closed.

Files must be UTF-8 (a BOM and CRLF line endings are kept) and at most 2 MB.

## Layout

| Path | Contents |
| --- | --- |
| `core/` | Platform-independent logic: lexer, undo history, search, file decoding. A separate Gradle build with JVM unit tests. |
| `app/` | The Android app (activity, editor view, search bar, session storage). |

## Building

GitHub Actions builds it with `.github/workflows/native-apk.yml` on every push
to `main` that touches `native/`, or on demand from the Actions tab.

Locally, with the Android SDK installed:

```sh
cd native
./gradlew -p core test        # core unit tests (no Android SDK needed)
./gradlew :app:assembleDebug  # app/build/outputs/apk/debug/app-debug.apk
```
