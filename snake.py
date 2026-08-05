"""贪吃蛇核心逻辑模块。

只包含与界面无关的纯逻辑：棋盘、蛇、食物、移动、碰撞判定、计分。
可被任何 UI（终端、pygame、GUI）复用。
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from random import randint
from typing import Deque, List, Optional, Tuple

# 方向用 (dx, dy)，y 轴向下为正（屏幕坐标系）
Point = Tuple[int, int]


class Direction(Enum):
    UP = (0, -1)
    DOWN = (0, 1)
    LEFT = (-1, 0)
    RIGHT = (1, 0)


class GameState(Enum):
    RUNNING = "running"
    GAME_OVER = "game_over"
    WIN = "win"


@dataclass
class SnakeGame:
    """贪吃蛇核心逻辑。

    棋盘大小为 width x height，用屏幕坐标（原点左上）。
    蛇头为 deque 的左侧（popleft/appendleft 用于头部）。

    注意事项：
    - 蛇不能直接反向（例如向左移动时不能按右）。
    - 撞墙或撞到自己身体则游戏结束。
    - 吃到食物增长并以新食物替换，否则保持长度尾随移动。
    """

    width: int = 20
    height: int = 20
    # 初始蛇：从中间向右，长度 3
    initial_length: int = 3
    speed: float = 0.15  # 每步间隔秒数，UI 层使用

    _snake: Deque[Point] = field(init=False)
    _direction: Direction = field(init=False)
    _pending_direction: Optional[Direction] = field(init=False, default=None)
    food: Optional[Point] = field(init=False)
    score: int = field(init=False, default=0)
    state: GameState = field(init=False, default=GameState.RUNNING)

    def __post_init__(self) -> None:
        cx = self.width // 2
        cy = self.height // 2
        self._snake = deque(
            [(cx - i, cy) for i in range(self.initial_length)], maxlen=None
        )
        self._direction = Direction.RIGHT
        self._pending_direction = None
        self.score = 0
        self.state = GameState.RUNNING
        self._spawn_food()

    # ---------- 只读接口 ----------

    @property
    def snake(self) -> List[Point]:
        """从头到尾的蛇身坐标列表。"""
        return list(self._snake)

    @property
    def head(self) -> Point:
        return self._snake[0]

    @property
    def direction(self) -> Direction:
        return self._direction

    # ---------- 控制 ----------

    def set_direction(self, direction: Direction) -> None:
        """设定下一步方向。

        允许“预输入”：在当前一步尚未消费前先缓存方向。
        仅接受合法的方向变化（不允许 180 度反向）。
        """
        if self.state != GameState.RUNNING:
            return
        # 对比时用当前生效方向；反向（dx+dx==0 且 dy+dy==0）不合法
        cur = self._pending_direction or self._direction
        if cur.value[0] + direction.value[0] == 0 and cur.value[1] + direction.value[1] == 0:
            return
        self._pending_direction = direction

    # ---------- 主循环 ----------

    def step(self) -> GameState:
        """推进一帧。返回当前游戏状态。"""
        if self.state != GameState.RUNNING:
            return self.state

        # 消费预输入方向
        if self._pending_direction is not None:
            self._direction = self._pending_direction
            self._pending_direction = None

        dx, dy = self._direction.value
        new_head = (self.head[0] + dx, self.head[1] + dy)

        # 撞墙判定
        if not (0 <= new_head[0] < self.width and 0 <= new_head[1] < self.height):
            self.state = GameState.GAME_OVER
            return self.state

        # 吃到食物
        ate = new_head == self.food

        # 撞自身判定（若吃到食物，尾巴会移动，因此不算尾巴那一格）
        body_to_check = list(self._snake)
        if not ate:
            # 没吃到时尾巴要移除，撞到即将移除的尾巴不算死
            body_to_check = body_to_check[:-1]
        if new_head in body_to_check:
            self.state = GameState.GAME_OVER
            return self.state

        # 移动蛇
        self._snake.appendleft(new_head)
        if ate:
            self.score += 1
            self._spawn_food()
            # 检查是否已填满棋盘（胜利）
            if len(self._snake) == self.width * self.height:
                self.state = GameState.WIN
        else:
            self._snake.pop()

        return self.state

    # ---------- 内部 ----------

    def _spawn_food(self) -> None:
        """在空白格子随机生成食物。若无处可放则触发胜利。"""
        occupied = set(self._snake)
        if len(occupied) >= self.width * self.height:
            self.state = GameState.WIN
            self.food = None
            return
        while True:
            candidate = (randint(0, self.width - 1), randint(0, self.height - 1))
            if candidate not in occupied:
                self.food = candidate
                return


# ---------- 简单自测 / 示例 ----------

def _demo(n_steps: int = 20) -> None:
    """在终端跑几步并打印棋盘，用于验证核心逻辑。"""
    game = SnakeGame(width=8, height=8)
    # 走一个简单路径演示：右、下、左
    plan = [Direction.RIGHT] * 4 + [Direction.DOWN] * 4 + [Direction.LEFT] * 4
    idx = 0

    def render() -> str:
        grid = [["." for _ in range(game.width)] for _ in range(game.height)]
        for x, y in game.snake:
            grid[y][x] = "o"
        hx, hy = game.head
        grid[hy][hx] = "H"
        if game.food:
            fx, fy = game.food
            grid[fy][fx] = "F"
        return "\n".join("".join(row) for row in grid)

    print(render())
    for _ in range(n_steps):
        if idx < len(plan):
            game.set_direction(plan[idx])
            idx += 1
        state = game.step()
        print(f"score={game.score} state={state.value}")
        print(render())
        if state != GameState.RUNNING:
            break


if __name__ == "__main__":
    _demo()
