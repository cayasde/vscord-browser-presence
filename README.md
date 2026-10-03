<div align="center">

[<img width="256" alt="VSCord Logo" src="https://i.imgur.com/n7ieZfW.png" />](https://github.com/cayasde/vscord-browser-presence)

</div>

<br />

# VSCord Browser Presence

Fork of [VSCord](https://github.com/LeonardSSH/vscord) that publishes VS Code activity through Discord's Social SDK. It does not require the Discord desktop client; Discord account authorization is handled through OAuth in a browser.

> Remember to 🌟 this GitHub if you 💖 it.

## Requirements

- Windows x64 and VS Code 1.53 or newer.
- The Discord Social SDK C++ package, downloaded from the Discord Developer Portal.
- A Discord application configured with the `http://127.0.0.1/callback` OAuth redirect and **Public Client** enabled.
- MinGW-w64 `g++` available on `PATH` to build the native host.

The extension stores its rotating OAuth refresh token using VS Code's encrypted SecretStorage. Do not copy the token into settings, source files, or chat.
See Discord's [Social SDK getting started guide](https://discord.com/developers/docs/social-sdk/getting_started.html) and [SDK Terms](https://support-dev.discord.com/hc/en-us/articles/30225844245271-Discord-Social-SDK-Terms) for application setup and usage requirements.

## 📌 Features

- Shows what you're working on!
- Publish presence without a running Discord desktop client.
- Packed with 60+ extension settings!
- Tons of variable to use!
- Support for over 130+ of the most popular languages!
- Support custom images (using HTTP link)
- Support custom button link!
- Detect when you are Debugging!
- Detect when you are using the [Insiders build](https://code.visualstudio.com/insiders/)!
- Detect when you are Idling!

## 👀 Preview

![1](https://i.imgur.com/LaB4TqM.png)
![2](https://i.imgur.com/yTFIFiK.png)
![3](https://i.imgur.com/5OOkKUW.png)

## 📥 Installation

The Discord SDK binaries are not stored in this repository. Extract the SDK package from the Developer Portal, then build and install the extension locally:

```powershell
npm ci
$env:DISCORD_SOCIAL_SDK_ROOT = "C:\path\to\discord_social_sdk"
npm run build:social-sdk
npx vsce package
code --install-extension .\vscord-browser-presence-0.1.6.vsix
```

On first activation, the SDK opens Discord OAuth authorization in the default browser. The application ID is configured by `vscord.app.id`. Set `vscord.app.activityName` to customize the name displayed after "Playing"; leave it empty to use the Discord application name.

![a4](https://i.imgur.com/qMzox38.gif)

## ⚙️ Configuration

The following variables will be replaced with the respective value in custom strings.<br>

| Variable                              | Value                                              |
| ------------------------------------- | -------------------------------------------------- |
| `{app_name}`                          | current editor name                                |
| `{app_id}`                            | editor name that's suitable for using inside url   |
| `{file_name}`                         | name of the file                                   |
| `{file_extension}`                    | extension of the file                              |
| `{file_size}`                         | size of the file                                   |
| `{folder_and_file}`                   | folder and file name                               |
| `{relative_file_path}`                | filepath relative to the workspace folder          |
| `{directory_name}`                    | directory name                                     |
| `{full_directory_name}`               | full directory name                                |
| `{workspace}`                         | name of the workspace                              |
| `{workspace_folder}`                  | name of the workspace folder                       |
| `{workspace_and_folder}`              | name of the workspace and folder                   |
| `{lang}` \| `{Lang}` \| `{LANG}`      | format of the lang string (css, Css, CSS)          |
| `{a_lang}` \| `{a_Lang}`\| `{a_LANG}` | same as the above, but prefixes with "a" or "an"   |
| `{problems}`                          | problems text defined in settings                  |
| `{problems_pluralize}`                | the word `problem`, pluralized by count            |
| `{problems_count}`                    | number of problems                                 |
| `{problems_count_errors}`             | number of problems that are errors                 |
| `{problems_count_warnings}`           | number of problems that are warnings               |
| `{problems_count_infos}`              | number of problems that are infos                  |
| `{problems_count_hints}`              | number of problems that are hints                  |
| `{line_count}`                        | number of lines                                    |
| `{current_line}`                      | current line                                       |
| `{current_column}`                    | current column                                     |
| `{git_owner}`                         | current git repository owner                       |
| `{git_repo}`                          | repository name for current repository             |
| `{git_branch}`                        | current git branch                                 |
| `{git_protocol}`                      | git protocol (https, http, ssh)                    |
| `{git_resource}`                      | git resource link (etc: github.com) (exclude port) |
| `{git_host}`                          | git host link (etc: github.com) (include port)     |
| `{git_port}`                          | pot for the git link                               |
| `{git_href}`                          | href to the git repository                         |
| `{git_url}`                           | url link to the git repository                     |
| `{empty}`                             | an empty space                                     |

## 👨‍💻 Contributing

To contribute to this repository, feel free to create a new fork of the repository and submit a pull request.

1. Fork / Clone the `main` branch.
2. Create a new branch in your fork.
3. Make your changes.
4. Commit your changes and push them.
5. Submit a Pull Request [here](https://github.com/cayasde/vscord-browser-presence/pulls)!

## 👨‍💻 Adding a new language

We have a guide for adding a new language [here](ADDING_LANGUAGE.md)!

## 🎉 Thanks

- [discordjs](https://github.com/discordjs/) - Creator of Discord RPC Client
- [iCrawl](https://github.com/iCrawl) - Creator of [discord-vscode](https://github.com/iCrawl/discord-vscode)
- [Satoqz](https://github.com/Satoqz) - Creator of [vscode-discord](https://github.com/Satoqz/vscode-discord/)

_Much of the code in this repository is based on [iCrawl/discord-vscode](https://github.com/iCrawl/discord-vscode) & [Satoqz/vscode-discord](https://github.com/Satoqz/vscode-discord). This extension would not exist without them._

## 📋 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
