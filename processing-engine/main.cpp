#include <algorithm>
#include <condition_variable>
#include <cstdint>
#include <iostream>
#include <map>
#include <mutex>
#include <queue>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

struct Frame {
    std::size_t index;
    std::vector<std::uint8_t> pixels;
};

struct Filter {
    std::string name;
    int value = 0;
};

int integer(const std::string& text, int minimum, int maximum) {
    std::size_t end;
    const int value = std::stoi(text, &end);
    if (end != text.size() || value < minimum || value > maximum) {
        throw std::runtime_error("Integer argument out of range: " + text);
    }
    return value;
}

std::vector<Filter> parse_filters(const std::string& text) {
    std::vector<Filter> filters;
    if (text == "none") return filters;
    std::istringstream stream(text);
    std::string token;
    while (std::getline(stream, token, ',')) {
        if (token == "grayscale" || token == "invert") {
            filters.push_back({token, 0});
        } else if (token.starts_with("brightness:")) {
            filters.push_back({"brightness", integer(token.substr(11), -100, 100)});
        } else {
            throw std::runtime_error("Unknown filter: " + token);
        }
    }
    if (filters.empty() || text.back() == ',') {
        throw std::runtime_error("Invalid filter flow");
    }
    return filters;
}

void apply_filters(Frame& frame, const std::vector<Filter>& filters) {
    for (const auto& filter : filters) {
        if (filter.name == "grayscale") {
            for (std::size_t i = 0; i < frame.pixels.size(); i += 3) {
                const auto gray = static_cast<std::uint8_t>(
                    (77 * frame.pixels[i] + 150 * frame.pixels[i + 1]
                     + 29 * frame.pixels[i + 2]) >> 8);
                frame.pixels[i] = frame.pixels[i + 1] = frame.pixels[i + 2] = gray;
            }
        } else {
            const int offset = filter.value * 255 / 100;
            for (auto& pixel : frame.pixels) {
                pixel = filter.name == "invert"
                    ? 255 - pixel
                    : std::clamp(static_cast<int>(pixel) + offset, 0, 255);
            }
        }
    }
}

void process(std::size_t frame_size, int thread_count, const std::vector<Filter>& filters) {
    std::queue<Frame> work;
    std::map<std::size_t, Frame> ready;
    std::mutex mutex;
    std::condition_variable changed;
    const std::size_t capacity = static_cast<std::size_t>(thread_count) * 2;
    std::size_t in_flight = 0;
    std::size_t frame_count = 0;
    bool finished = false;
    std::string error;

    auto fail = [&](const std::string& message) {
        std::lock_guard lock(mutex);
        if (error.empty()) error = message;
        changed.notify_all();
    };

    std::vector<std::jthread> workers;
    std::jthread writer;
    try {
        for (int i = 0; i < thread_count; ++i) {
            workers.emplace_back([&] {
                try {
                    while (true) {
                        Frame frame;
                        {
                            std::unique_lock lock(mutex);
                            changed.wait(lock, [&] { return finished || !error.empty() || !work.empty(); });
                            if (!error.empty() || work.empty()) return;
                            frame = std::move(work.front());
                            work.pop();
                        }
                        apply_filters(frame, filters);
                        {
                            std::lock_guard lock(mutex);
                            ready.emplace(frame.index, std::move(frame));
                        }
                        changed.notify_all();
                    }
                } catch (const std::exception& exception) {
                    fail(exception.what());
                }
            });
        }

        writer = std::jthread([&] {
            try {
                std::size_t next = 0;
                while (true) {
                    Frame frame;
                    {
                        std::unique_lock lock(mutex);
                        changed.wait(lock, [&] {
                            return !error.empty() || ready.contains(next) || (finished && in_flight == 0);
                        });
                        if (!error.empty() || (finished && in_flight == 0)) return;
                        frame = std::move(ready.at(next));
                        ready.erase(next);
                    }
                    std::cout.write(reinterpret_cast<const char*>(frame.pixels.data()),
                                    static_cast<std::streamsize>(frame.pixels.size()));
                    if (!std::cout) throw std::runtime_error("Cannot write output frame");
                    {
                        std::lock_guard lock(mutex);
                        --in_flight;
                    }
                    ++next;
                    changed.notify_all();
                }
            } catch (const std::exception& exception) {
                fail(exception.what());
            }
        });

        while (true) {
            {
                std::unique_lock lock(mutex);
                // Bound all queued, processing, and reordered frames, not just the work queue.
                changed.wait(lock, [&] { return !error.empty() || in_flight < capacity; });
                if (!error.empty()) break;
            }
            Frame frame{frame_count, std::vector<std::uint8_t>(frame_size)};
            std::cin.read(reinterpret_cast<char*>(frame.pixels.data()),
                          static_cast<std::streamsize>(frame_size));
            if (std::cin.gcount() == 0 && std::cin.eof()) break;
            if (std::cin.gcount() != static_cast<std::streamsize>(frame_size)) {
                throw std::runtime_error("Incomplete input frame");
            }
            {
                std::lock_guard lock(mutex);
                work.push(std::move(frame));
                ++in_flight;
                ++frame_count;
            }
            changed.notify_all();
        }
    } catch (const std::exception& exception) {
        fail(exception.what());
    }

    {
        std::lock_guard lock(mutex);
        finished = true;
    }
    changed.notify_all();
    workers.clear();
    if (writer.joinable()) writer.join();
    if (!error.empty()) throw std::runtime_error(error);
    if (frame_count == 0) throw std::runtime_error("Input contains no frames");
    std::cout.flush();
    if (!std::cout) throw std::runtime_error("Cannot flush output");
    std::cerr << "Processed " << frame_count << " frames using " << thread_count << " workers\n";
}

int main(int argc, char* argv[]) {
    try {
        if (argc != 5) {
            throw std::runtime_error("Usage: video-engine WIDTH HEIGHT THREADS FILTERS\n"
                                     "Filters: none or grayscale,invert,brightness:20");
        }
        const int width = integer(argv[1], 1, 8192);
        const int height = integer(argv[2], 1, 8192);
        const int threads = integer(argv[3], 1, 32);
        const auto filters = parse_filters(argv[4]);
        std::ios::sync_with_stdio(false);
        std::cin.tie(nullptr);
        process(static_cast<std::size_t>(width) * height * 3, threads, filters);
        return 0;
    } catch (const std::exception& exception) {
        std::cerr << exception.what() << '\n';
        return 1;
    }
}
