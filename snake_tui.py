import curses, random

def main(stdscr):
    curses.curs_set(0)
    stdscr.nodelay(1)
    h, w = stdscr.getmaxyx()
    snake = [(h // 2, w // 2)]
    dx, dy = 0, 1
    food = (random.randrange(h), random.randrange(w))
    score = 0
    while True:
        key = stdscr.getch()
        if key in (ord('q'), 27):
            break
        elif key == curses.KEY_UP and dx != 1:
            dx, dy = -1, 0
        elif key == curses.KEY_DOWN and dx != -1:
            dx, dy = 1, 0
        elif key == curses.KEY_LEFT and dy != 1:
            dx, dy = 0, -1
        elif key == curses.KEY_RIGHT and dy != -1:
            dx, dy = 0, 1
        head = (snake[0][0] + dx, snake[0][1] + dy)
        if (head in snake or head[0] < 0 or head[0] >= h
                or head[1] < 0 or head[1] >= w):
            break
        snake.insert(0, head)
        if head == food:
            score += 1
            food = (random.randrange(h), random.randrange(w))
            while food in snake:
                food = (random.randrange(h), random.randrange(w))
        else:
            snake.pop()
        stdscr.clear()
        stdscr.addstr(0, 0, f"Score: {score}  (q to quit)")
        stdscr.addch(*food, '@')
        for x, y in snake:
            stdscr.addch(x, y, 'O')
        stdscr.refresh()
        curses.napms(100)
    stdscr.addstr(h - 1, 0, "Game Over! Press any key...")
    stdscr.nodelay(0)
    stdscr.getch()

curses.wrapper(main)
