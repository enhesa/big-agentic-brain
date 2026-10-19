def order_shipped(order_id: str, tracking: str) -> dict:
    return {"type": "order.shipped", "order": order_id, "tracking": tracking}
