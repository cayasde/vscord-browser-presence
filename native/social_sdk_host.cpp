#define DISCORDPP_IMPLEMENTATION
#include "discordpp.h"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <mutex>
#include <queue>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

std::string cleanLine(std::string value)
{
    for (char& character : value) {
        if (character == '\r' || character == '\n' || character == '\t') {
            character = ' ';
        }
    }
    return value;
}

std::string decodeBase64(const std::string& input)
{
    static const std::string alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string output;
    int value = 0;
    int bits = -8;

    for (const char character : input) {
        if (character == '=') {
            break;
        }
        const auto index = alphabet.find(character);
        if (index == std::string::npos) {
            return {};
        }
        value = (value << 6) | static_cast<int>(index);
        bits += 6;
        if (bits >= 0) {
            output.push_back(static_cast<char>((value >> bits) & 0xff));
            bits -= 8;
        }
    }
    return output;
}

std::vector<std::string> splitFields(const std::string& line)
{
    std::vector<std::string> fields;
    std::size_t start = 0;
    while (start <= line.size()) {
        const auto separator = line.find('\t', start);
        if (separator == std::string::npos) {
            fields.push_back(line.substr(start));
            break;
        }
        fields.push_back(line.substr(start, separator - start));
        start = separator + 1;
    }
    return fields;
}

class Host {
public:
    explicit Host(std::uint64_t applicationId) : applicationId_(applicationId)
    {
        client_.SetApplicationId(applicationId_);
        client_.SetStatusChangedCallback([this](auto status, auto error, auto detail) {
            if (status == discordpp::Client::Status::Ready) {
                const auto user = client_.GetCurrentUserV2();
                if (!user || user->Id() == 0) {
                    emit("ERROR", "Discord Social SDK connected without a current user.");
                } else {
                    emit("READY", std::to_string(user->Id()));
                }
                return;
            }
            if (static_cast<int>(error) != 0) {
                emit("ERROR", discordpp::Client::StatusToString(status) + ": " +
                                   discordpp::Client::ErrorToString(error) + " (" +
                                   std::to_string(detail) + ")");
            }
            if (status == discordpp::Client::Status::Disconnected) {
                emit("DISCONNECTED");
            }
        });
    }

    int run()
    {
        emit("STARTED");
        std::thread inputThread([this] { readInput(); });

        while (running_) {
            discordpp::RunCallbacks();
            processCommands();
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }

        client_.ClearRichPresence();
        client_.Disconnect();
        for (int index = 0; index < 20; ++index) {
            discordpp::RunCallbacks();
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        if (inputThread.joinable()) {
            inputThread.join();
        }
        return 0;
    }

private:
    void emit(const std::string& name, const std::string& payload = {})
    {
        std::lock_guard<std::mutex> lock(outputMutex_);
        std::cout << name;
        if (!payload.empty()) {
            std::cout << '\t' << cleanLine(payload);
        }
        std::cout << '\n' << std::flush;
    }

    void emitTokens(const std::string& accessToken, const std::string& refreshToken)
    {
        std::lock_guard<std::mutex> lock(outputMutex_);
        std::cout << "TOKENS\t" << accessToken << '\t' << refreshToken << '\n' << std::flush;
    }

    void readInput()
    {
        std::string line;
        while (std::getline(std::cin, line)) {
            std::lock_guard<std::mutex> lock(queueMutex_);
            commands_.push(std::move(line));
        }
        std::lock_guard<std::mutex> lock(queueMutex_);
        commands_.push("EXIT");
    }

    void processCommands()
    {
        std::queue<std::string> pending;
        {
            std::lock_guard<std::mutex> lock(queueMutex_);
            pending.swap(commands_);
        }

        while (!pending.empty()) {
            const auto fields = splitFields(pending.front());
            pending.pop();
            if (fields.empty()) {
                continue;
            }

            if (fields[0] == "AUTHORIZE") {
                authorize();
            } else if (fields[0] == "REFRESH" && fields.size() == 2) {
                refreshToken(decodeBase64(fields[1]));
            } else if (fields[0] == "TOKENS_STORED") {
                connectWithPendingToken();
            } else if (fields[0] == "TOKEN_STORE_FAILED") {
                pendingAccessToken_.clear();
                emit("ERROR", "VS Code could not securely store the Discord refresh token.");
            } else if (fields[0] == "PRESENCE" && fields.size() == 12) {
                setPresence(fields);
            } else if (fields[0] == "CLEAR") {
                client_.ClearRichPresence();
            } else if (fields[0] == "DISCONNECT") {
                client_.ClearRichPresence();
                client_.Disconnect();
            } else if (fields[0] == "EXIT") {
                running_ = false;
            }
        }
    }

    void authorize()
    {
        if (authorizationInProgress_) {
            return;
        }
        authorizationInProgress_ = true;

        auto verifier = std::make_shared<discordpp::AuthorizationCodeVerifier>(
            client_.CreateAuthorizationCodeVerifier());
        discordpp::AuthorizationArgs arguments{};
        arguments.SetClientId(applicationId_);
        arguments.SetScopes(discordpp::Client::GetDefaultPresenceScopes());
        arguments.SetCodeChallenge(verifier->Challenge());

        client_.Authorize(arguments, [this, verifier](auto result, auto code, auto redirectUri) {
            authorizationInProgress_ = false;
            if (!result.Successful()) {
                emit("AUTH_ERROR", result.ToString());
                return;
            }

            client_.GetToken(applicationId_, code, verifier->Verifier(), redirectUri,
                             [this](auto tokenResult, auto accessToken, auto refreshToken,
                                    auto tokenType, auto, auto) {
                if (!tokenResult.Successful()) {
                    emit("AUTH_ERROR", tokenResult.ToString());
                    return;
                }
                pendingTokenType_ = tokenType;
                pendingAccessToken_ = accessToken;
                emitTokens(accessToken, refreshToken);
            });
        });
    }

    void refreshToken(const std::string& token)
    {
        if (token.empty()) {
            authorize();
            return;
        }
        client_.RefreshToken(applicationId_, token,
                             [this](auto result, auto accessToken, auto refreshToken,
                                    auto tokenType, auto, auto) {
            if (!result.Successful()) {
                emit("AUTH_REQUIRED", result.ToString());
                return;
            }
            pendingTokenType_ = tokenType;
            pendingAccessToken_ = accessToken;
            emitTokens(accessToken, refreshToken);
        });
    }

    void connectWithPendingToken()
    {
        if (pendingAccessToken_.empty()) {
            return;
        }
        const auto accessToken = std::move(pendingAccessToken_);
        client_.UpdateToken(pendingTokenType_, accessToken, [this](auto result) {
            if (!result.Successful()) {
                emit("ERROR", result.ToString());
                return;
            }
            client_.Connect();
        });
    }

    void setPresence(const std::vector<std::string>& fields)
    {
        discordpp::Activity activity{};
        activity.SetType(discordpp::ActivityTypes::Playing);

        const auto details = decodeBase64(fields[1]);
        const auto state = decodeBase64(fields[2]);
        const auto largeImage = decodeBase64(fields[3]);
        const auto largeText = decodeBase64(fields[4]);
        const auto smallImage = decodeBase64(fields[5]);
        const auto smallText = decodeBase64(fields[6]);
        if (!details.empty()) activity.SetDetails(details);
        if (!state.empty()) activity.SetState(state);

        if (!largeImage.empty() || !largeText.empty() || !smallImage.empty() || !smallText.empty()) {
            discordpp::ActivityAssets assets{};
            if (!largeImage.empty()) assets.SetLargeImage(largeImage);
            if (!largeText.empty()) assets.SetLargeText(largeText);
            if (!smallImage.empty()) assets.SetSmallImage(smallImage);
            if (!smallText.empty()) assets.SetSmallText(smallText);
            activity.SetAssets(std::move(assets));
        }

        try {
            const auto startTime = std::stoull(fields[7]);
            if (startTime > 0) {
                discordpp::ActivityTimestamps timestamps{};
                timestamps.SetStart(startTime);
                activity.SetTimestamps(std::move(timestamps));
            }
        } catch (const std::exception&) {
            emit("ERROR", "Invalid Rich Presence timestamp.");
            return;
        }

        for (const std::size_t index : {8u, 10u}) {
            const auto label = decodeBase64(fields[index]);
            const auto url = decodeBase64(fields[index + 1]);
            if (label.empty() || url.empty()) {
                continue;
            }
            discordpp::ActivityButton button{};
            button.SetLabel(label);
            button.SetUrl(url);
            activity.AddButton(std::move(button));
        }

        client_.UpdateRichPresence(std::move(activity), [this](auto result) {
            if (!result.Successful()) {
                emit("PRESENCE_ERROR", result.ToString());
            }
        });
    }

    const std::uint64_t applicationId_;
    discordpp::Client client_;
    std::atomic<bool> running_{true};
    std::mutex queueMutex_;
    std::mutex outputMutex_;
    std::queue<std::string> commands_;
    std::string pendingAccessToken_;
    discordpp::AuthorizationTokenType pendingTokenType_ = discordpp::AuthorizationTokenType::Bearer;
    bool authorizationInProgress_ = false;
};

} // namespace

int main(int argc, char** argv)
{
    if (argc != 2) {
        std::cerr << "Expected the Discord application ID as the only argument.\n";
        return 2;
    }
    try {
        const auto applicationId = std::stoull(argv[1]);
        return Host(applicationId).run();
    } catch (const std::exception& error) {
        std::cerr << "Invalid Discord application ID: " << error.what() << '\n';
        return 2;
    }
}
