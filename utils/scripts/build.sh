#!/bin/bash
# Stop at the first failing step so a failed configuration (for example, the
# AdMob removal check in utils/config.js) never produces an APK.
set -e

# Default values
app="paid"
mode="d"
fdroidFlag=""
packageType="apk"  # New default: apk or aar
webpackmode="development"
cordovamode=""

# Check all arguments for specific values
for arg in "$@"; do
    case "$arg" in
        "free"|"paid")
            app="$arg"
            ;;
        "p"|"prod"|"d"|"dev")
            mode="$arg"
            ;;
        "fdroid")
            fdroidFlag="fdroid"
            ;;
        "apk"|"bundle")
            packageType="$arg"
            ;;
        *)
            echo "Warning: Unknown argument '$arg' ignored"
            ;;
    esac
done

root=$(npm prefix)

if [ -n "$TMPDIR" ] && [ -r "$TMPDIR" ] && [ -w "$TMPDIR" ]; then
  tmpdir="$TMPDIR"
elif [ -r "/tmp" ] && [ -w "/tmp" ]; then
  tmpdir="/tmp"
else
  echo "Warning: No usable temporary directory found (TMPDIR or /tmp not accessible). Skipping fdroid.bool file." >&2
  tmpdir=""
fi

if [ "$fdroidFlag" = "fdroid" ]; then
  if [ -n "$tmpdir" ]; then
    echo "true" > "$tmpdir/fdroid.bool"
  fi

  # Remove only if installed
  if [ -d "plugins/com.foxdebug.acode.rk.exec.proot" ]; then
    cordova plugin remove com.foxdebug.acode.rk.exec.proot
  fi

  if [ -d "plugins/cordova-plugin-iap" ]; then
    cordova plugin remove cordova-plugin-iap
  fi
else
  if [ -n "$tmpdir" ]; then
    echo "false" > "$tmpdir/fdroid.bool"
  fi

  # Add only if the src exists and not already installed
  if [ -d "src/plugins/proot" ] && [ ! -d "plugins/com.foxdebug.acode.rk.exec.proot" ]; then
    cordova plugin add src/plugins/proot/
  fi

  if [ -d "src/plugins/iap" ] && [ ! -d "plugins/cordova-plugin-iap" ]; then
    cordova plugin add src/plugins/iap/
  fi
fi



# Normalize mode values
if [ "$mode" = "p" ] || [ "$mode" = "prod" ]
then
mode="p"
webpackmode="production"
cordovamode="--release"
fi

# Set build target based on packageType
if [ "$packageType" = "bundle" ]; then
    echo "Building AAR library file..."
else
    echo "Building APK file..."
fi

echo "type : $packageType"

echo "node ./utils/config.js $mode $app"
node ./utils/config.js "$mode" "$app"

echo "rspack --mode $webpackmode"
rspack --mode "$webpackmode"

echo "cordova build android $cordovamode -- --packageType=$packageType"
cordova build android $cordovamode -- --packageType="$packageType"
