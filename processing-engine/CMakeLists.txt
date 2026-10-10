cmake_minimum_required(VERSION 3.16)
project(video_engine LANGUAGES CXX)

find_package(Threads REQUIRED)
add_executable(video-engine main.cpp)
target_compile_features(video-engine PRIVATE cxx_std_20)
target_compile_options(video-engine PRIVATE -Wall -Wextra -Wpedantic)
target_link_libraries(video-engine PRIVATE Threads::Threads)
