cmake_minimum_required(VERSION 3.25)
project(pet_desktop_fullscreen_probe LANGUAGES C)

if(NOT WIN32)
  message(FATAL_ERROR "The fullscreen probe requires Windows")
endif()

add_executable(fullscreen-probe main.c)
set_target_properties(fullscreen-probe PROPERTIES C_STANDARD 11 C_STANDARD_REQUIRED YES)
target_compile_definitions(fullscreen-probe PRIVATE _WIN32_WINNT=0x0A00 WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(fullscreen-probe PRIVATE user32 dwmapi shell32)

if(MSVC)
  set_property(TARGET fullscreen-probe PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded")
  target_compile_options(fullscreen-probe PRIVATE /W4 /sdl /guard:cf)
  target_link_options(fullscreen-probe PRIVATE /guard:cf /DYNAMICBASE /NXCOMPAT)
endif()
