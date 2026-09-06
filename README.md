# Output Manager (Decky plugin)

Switch Steam Gaming Mode's display and audio outputs from the Quick Access
Menu.

## Compatibility
This plugin **only** works on Bazzite, ChimeraOS and other SteamOS derivatives that expose the *OUTPUT_CONNECTOR* variable in the gamescope session. This plugin **does NOT** work on vanilla SteamOS, and as such cannot be submitted to the Decky Plugin Store.

## Features

- **Displays section**: tap a connected display to switch to it. This
  restarts the gamescope session.
- **Audio section**: tap a known audio output to make it the default sink
  immediately.
- **Manage Outputs**: a full list of every display/audio output you've
  ever configured, including ones that are currently unplugged (their
  settings are kept until you explicitly forget them). From here you can:
  - Rename any output (cosmetic label only)
  - Hide/unhide it from the main panel
  - Set a **default audio device** for each display, automatically applied
    whenever you switch to that display
  - Forget a device's saved settings if it's unplugged
- **Default display**: configurable in Settings, automatically applied
  when Gaming Mode boots and when the system wakes from sleep.
- **Advanced settings**: override certain variables under the hood. Good for debugging

<br>
<a href="https://www.buymeacoffee.com/joeatethebeans">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" width="150">
</a>
